// NeutralOutline.x
//
// Raises the contrast of Reddit's neutral outline tokens on near-black themes.
//
// This hooks Palette_RedditPalette.NeutralColors -- the app's own colour
// palette -- rather than any individual view. Every consumer of these tokens
// (dividers, button outlines, text-field borders, card edges, separators in
// screens we have never looked at) picks up the new value through its normal
// path, because the palette is what changed.
//
// Each getter only substitutes when the app's own value is essentially black,
// so the light theme and the ordinary (non-AMOLED) dark theme are untouched.

#import <UIKit/UIKit.h>
#import <objc/runtime.h>

// ---------------------------------------------------------------- tuning ---
// Grey level per token, 0.0 = black, 1.0 = white.
// For reference: 0.10 = #191919 (the current value), 0.20 = #333333.
static const CGFloat kRFBorder        = 0.22;   // button / field outlines
static const CGFloat kRFBorderDivider = 0.20;   // divider lines
static const CGFloat kRFBorderMedium  = 0.30;
static const CGFloat kRFBorderStrong  = 0.42;
static const CGFloat kRFBorderWeak    = 0.15;

// Substitute only when the original colour's brightness over a black
// background is at or below this. Alpha is taken into account, so a
// white-at-10%-alpha hairline is caught as well as a flat #191919.
static const CGFloat kRFMaxEffective  = 0.16;

// Set to 1 to log each original colour once, readable with:
//   ipsw idev syslog | grep NeutralOutline
#define RF_OUTLINE_LOG 1
// ---------------------------------------------------------------------------

// 0 border, 1 borderDivider, 2 borderMedium, 3 borderStrong, 4 borderWeak
static NSArray *gOutline = nil;

static BOOL RFTooDark(UIColor *c) {
    if (!c) return NO;
    CGFloat r = 0, g = 0, b = 0, a = 0;
    if (![c getRed:&r green:&g blue:&b alpha:&a]) return NO;
    if (a < 0.02) return NO;   // deliberately invisible; leave it alone
    CGFloat eff = (0.2126 * r + 0.7152 * g + 0.0722 * b) * a;
    return eff <= kRFMaxEffective;
}

#if RF_OUTLINE_LOG
#define RF_LOG_ONCE(name, color) do {                                        \
    static BOOL logged = NO;                                                 \
    if (!logged) {                                                           \
        logged = YES;                                                        \
        NSLog(@"[NeutralOutline] %s original = %@", name, color);            \
    }                                                                        \
} while (0)
#else
#define RF_LOG_ONCE(name, color) do { } while (0)
#endif

#define RF_TOKEN(sel, name, index)                                           \
- (UIColor *)sel {                                                           \
    UIColor *orig = %orig;                                                   \
    RF_LOG_ONCE(name, orig);                                                 \
    if (!RFTooDark(orig)) return orig;                                       \
    return [gOutline objectAtIndex:index];                                   \
}

%group NeutralPalette

%hook NeutralColors
RF_TOKEN(border,        "border",        0)
RF_TOKEN(borderDivider, "borderDivider", 1)
RF_TOKEN(borderMedium,  "borderMedium",  2)
RF_TOKEN(borderStrong,  "borderStrong",  3)
RF_TOKEN(borderWeak,    "borderWeak",    4)
%end

%end

static UIColor *RFGrey(CGFloat level) {
    return [UIColor colorWithRed:level green:level blue:level alpha:1.0];
}

%ctor {
    @autoreleasepool {
        Class neutral = objc_getClass("Palette_RedditPalette.NeutralColors");
        if (!neutral) {
            NSLog(@"[NeutralOutline] NeutralColors not found; not hooking");
            return;
        }

        gOutline = [[NSArray alloc] initWithObjects:
                    RFGrey(kRFBorder),
                    RFGrey(kRFBorderDivider),
                    RFGrey(kRFBorderMedium),
                    RFGrey(kRFBorderStrong),
                    RFGrey(kRFBorderWeak),
                    nil];

        %init(NeutralPalette, NeutralColors = neutral);
        NSLog(@"[NeutralOutline] hooked %@", NSStringFromClass(neutral));
    }
}
