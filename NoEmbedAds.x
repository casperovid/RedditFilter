// NoEmbedAds.x
//
// Strips ads from YouTube video embedded inside Reddit's in-app player.
//
// Reddit plays YouTube links through Google's youtube-ios-player-helper,
// which is a WKWebView loading YouTube's own iframe embed. Because the tweak
// runs inside the app, that web view is ours to configure: we inject a script
// that runs before any of YouTube's own scripts, intercepts the InnerTube
// player response, and removes the ad payload from it. The player then renders
// a video that, as far as it is concerned, has no ads attached.
//
// Nothing here depends on a third-party server. Playback is Google serving
// video to the phone, exactly as before.

#import <UIKit/UIKit.h>
#import <objc/runtime.h>

// Declared locally rather than importing WebKit, so the tweak needs no extra
// framework in the Makefile.
@interface WKUserScript : NSObject
- (instancetype)initWithSource:(NSString *)source
                 injectionTime:(NSInteger)injectionTime
              forMainFrameOnly:(BOOL)forMainFrameOnly;
@end

@interface WKUserContentController : NSObject
- (void)addUserScript:(id)userScript;
@end

@interface WKWebViewConfiguration : NSObject
@property (nonatomic, strong) WKUserContentController *userContentController;
@end

#define RF_AT_DOCUMENT_START 0

// Set to 1 to log what the script sees, readable with:
//   ipsw idev syslog | grep NoEmbedAds
#define RF_ADS_LOG 1

static NSString *const kRFScript = @"\
(function () {\n\
  if (window.__rfNoAds) { return; }\n\
  window.__rfNoAds = true;\n\
\n\
  var STRIP = ['adPlacements', 'playerAds', 'adSlots',\n\
               'adBreakHeartbeatParams', 'adParams', 'adServerData'];\n\
\n\
  function log(m) { try { window.webkit.messageHandlers; } catch (e) {} \n\
    try { console.log('[NoEmbedAds] ' + m); } catch (e) {} }\n\
\n\
  function scrub(o, depth) {\n\
    if (!o || typeof o !== 'object' || depth > 6) { return o; }\n\
    for (var i = 0; i < STRIP.length; i++) {\n\
      if (STRIP[i] in o) { delete o[STRIP[i]]; }\n\
    }\n\
    if (o.playerConfig && o.playerConfig.adConfig) { delete o.playerConfig.adConfig; }\n\
    if (o.playerResponse) { scrub(o.playerResponse, depth + 1); }\n\
    if (o.player && o.player.args) { scrub(o.player.args, depth + 1); }\n\
    return o;\n\
  }\n\
\n\
  function scrubText(t) {\n\
    try {\n\
      var j = JSON.parse(t);\n\
      scrub(j, 0);\n\
      log('scrubbed player response');\n\
      return JSON.stringify(j);\n\
    } catch (e) { return t; }\n\
  }\n\
\n\
  function isPlayerCall(u) {\n\
    return typeof u === 'string' && u.indexOf('/youtubei/v1/player') !== -1;\n\
  }\n\
\n\
  /* ---- fetch ---------------------------------------------------------- */\n\
  var origFetch = window.fetch;\n\
  if (origFetch) {\n\
    window.fetch = function (input, init) {\n\
      var url = (typeof input === 'string') ? input\n\
              : (input && input.url) ? input.url : '';\n\
      var p = origFetch.apply(this, arguments);\n\
      if (!isPlayerCall(url)) { return p; }\n\
      return p.then(function (res) {\n\
        return res.clone().text().then(function (t) {\n\
          return new Response(scrubText(t), {\n\
            status: res.status,\n\
            statusText: res.statusText,\n\
            headers: res.headers\n\
          });\n\
        }).catch(function () { return res; });\n\
      });\n\
    };\n\
  }\n\
\n\
  /* ---- XMLHttpRequest ------------------------------------------------- */\n\
  var origOpen = XMLHttpRequest.prototype.open;\n\
  XMLHttpRequest.prototype.open = function (m, u) {\n\
    this.__rfURL = u;\n\
    return origOpen.apply(this, arguments);\n\
  };\n\
\n\
  var origSend = XMLHttpRequest.prototype.send;\n\
  XMLHttpRequest.prototype.send = function () {\n\
    var xhr = this;\n\
    if (isPlayerCall(xhr.__rfURL)) {\n\
      /* Listen on the capture phase so this runs before the page's own\n\
         handler reads responseText. */\n\
      xhr.addEventListener('readystatechange', function () {\n\
        if (xhr.readyState !== 4) { return; }\n\
        try {\n\
          var cleaned = scrubText(xhr.responseText);\n\
          Object.defineProperty(xhr, 'responseText', {\n\
            configurable: true, get: function () { return cleaned; }\n\
          });\n\
          Object.defineProperty(xhr, 'response', {\n\
            configurable: true, get: function () { return cleaned; }\n\
          });\n\
        } catch (e) {}\n\
      }, true);\n\
    }\n\
    return origSend.apply(this, arguments);\n\
  };\n\
\n\
  /* ---- inline bootstrap data ------------------------------------------ */\n\
  try {\n\
    var stored;\n\
    Object.defineProperty(window, 'ytInitialPlayerResponse', {\n\
      configurable: true,\n\
      set: function (v) { stored = scrub(v, 0); },\n\
      get: function () { return stored; }\n\
    });\n\
  } catch (e) {}\n\
\n\
  /* ---- last resort ----------------------------------------------------- */\n\
  /* If an ad still renders, skip it rather than sit through it. */\n\
  setInterval(function () {\n\
    try {\n\
      var btn = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern');\n\
      if (btn) { btn.click(); return; }\n\
      if (document.querySelector('.ad-showing, .ytp-ad-player-overlay')) {\n\
        var v = document.querySelector('video');\n\
        if (v && isFinite(v.duration) && v.duration > 0) { v.currentTime = v.duration; }\n\
      }\n\
    } catch (e) {}\n\
  }, 400);\n\
\n\
  log('installed');\n\
})();\n\
";

static void RFInstall(WKWebViewConfiguration *configuration) {
    if (!configuration) return;

    WKUserContentController *ucc = configuration.userContentController;
    if (!ucc) return;

    // Don't install twice into the same controller.
    static const void *kRFMarked = &kRFMarked;
    if (objc_getAssociatedObject(ucc, kRFMarked)) return;
    objc_setAssociatedObject(ucc, kRFMarked, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

    Class scriptClass = objc_getClass("WKUserScript");
    if (!scriptClass) return;

    // forMainFrameOnly:NO is the important part -- YouTube's player lives in a
    // cross-origin iframe, and that frame is where the script has to run.
    id script = [[scriptClass alloc] initWithSource:kRFScript
                                      injectionTime:RF_AT_DOCUMENT_START
                                   forMainFrameOnly:NO];
    if (!script) return;

    [ucc addUserScript:script];

#if RF_ADS_LOG
    NSLog(@"[NoEmbedAds] injected into web view configuration %p", configuration);
#endif
}

%hook WKWebView

- (id)initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    RFInstall(configuration);
    return %orig;
}

%end

%ctor {
    @autoreleasepool {
#if RF_ADS_LOG
        NSLog(@"[NoEmbedAds] loaded");
#endif
    }
}
