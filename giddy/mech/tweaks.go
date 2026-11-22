package mech

// Our tweaks on top of the giddy brain (the default values keep its original behaviour, commit 70c8b23).
const (
	// tweakHopT: seconds of opening hop (jump + boost with the heading turned 60 degrees left), as in our TypeScript bot.
	// It acts before the bot can tell practice from free-for-all, so it changes free-for-all too.
	tweakHopT = 0.0
	// tweakLoseK: scale of the TTUN "losing" thresholds of the squad lose rule (1 = original).
	tweakLoseK = 1.0
	// tweakSquadT: time (s) after which the squad (practice) parameters take over from the cautious opening ones (20 = original).
	tweakSquadT = 20.0
	// tweakDropV: squad mode only, weight of uncontested supply drops in the calm loot choice (0 = never, as giddy; 1 = 3 cubes + missing HP).
	tweakDropV = 0.0
	// tweakFightDropR: squad mode only, radius (m) within which a landed, uncontested supply drop is captured mid-fight (0 = never).
	tweakFightDropR = 0.0
	// tweakNano: squad mode only, repair nanites right after plating in the upgrade order (false = original laser order).
	tweakNano = false

	// Squad (practice) parameters, applied by squadParams only.
	// tweakFinish: range (m) we close to on a weak foe (Params.Finish, 14 = original).
	tweakFinish = 14.0
	// tweakFinishHP: foe HP fraction under which we close in (Params.FinishHP, 0 = original 0.38).
	tweakFinishHP = 0.0
	// tweakFinishRush: boost while closing in on a weak foe more than 2*Finish away with energy > 30 (Params.FinishRush, false = original).
	tweakFinishRush = false
	// tweakPursue: chase an engaged foe out of line of sight when its HP fraction is under this (Params.Pursue, 1.01 = original: always).
	tweakPursue = 1.01
	// tweakStick: target score bonus for keeping the current target (Params.Stick, 120 = original).
	tweakStick = 120.0
	// tweakHear: squad mode only, look toward enemy sounds no visible mech explains and side-step unseen laser charges (false = original).
	tweakHear = false
	// tweakNpcGoneHP: a drone that vanishes from the observation below this HP fraction is dead and forgotten (0 = original: chased and shot for up to 12 s).
	tweakNpcGoneHP = 0.0
	// tweakCubeLevel: in-fight cube detours skip cubes on roofs or decks above our level, which cannot be picked up (false = original).
	tweakCubeLevel = false
	// tweakNoAirBoost: no boost while airborne outside escape and shell dodging, since boost in the air is a jet climb (false = original).
	tweakNoAirBoost = false
	// tweakNpcTie: ties between drones that hit us are broken by distance then id instead of map order (false = original, not reproducible).
	tweakNpcTie = false
	// tweakRear: squad mode only, target score bonus for a foe showing us its back (rear armor takes rear_mult damage),
	// and the rear multiplier counted in the lethal laser release (0 = original).
	tweakRear = 0.0
	// tweakFFAUntil: a death we did not cause switches to free-for-all play only if first seen before this time (s).
	// In 77 recorded free-for-all matches the first such death always came before 37 s, for every mech, so those
	// matches play exactly as before; in practice a late zone or drone death no longer drops the squad settings.
	// (0 = original: any such death, at any time.)
	tweakFFAUntil = 0.0
	// Squad mode only, mobility (boost = 19.5 m/s instead of 11.7 m/s walking; ground only, never while the laser charges):
	// tweakJinkBoost: boost the fight strafe when a target is visible and energy > 40.
	tweakJinkBoost = false
	// tweakDodgeBoost: boost on every bullet or laser dodge when energy > 25 (original: laser dodges only).
	tweakDodgeBoost = false
	// tweakThreatBoost: boost whenever moving under threat (a target, or hit in the last 2 s) with energy > 30.
	tweakThreatBoost = false
	// tweakMobUp: upgrade order plating, armor, servos, jets, reactor, then the laser order.
	tweakMobUp = false
	// tweakFlipFast: reverse the fight strafe about every 0.5 s (original: about every 1.1 s).
	tweakFlipFast = false
	// tweakChargeBoost: boost while charging the laser when hit in the last 2 s (energy > 30).
	tweakChargeBoost = false
	// tweakBoostHyst: the extra boosts above stop when energy falls under 30 and resume over 60; with lightning held,
	// the strafe and threat boosts also keep energy over 60 for its shots.
	tweakBoostHyst = false
	// Squad targeting (0 = original): tweakHPw weight of foe HP in target choice (0.2), tweakLowBonus bonus for a foe under
	// 30 % HP (100), tweakLethalK share of the partial-laser damage that must cover the foe's HP to release early (0.8).
	tweakHPw      = 0.0
	tweakLowBonus = 0.0
	tweakLethalK  = 0.0

	// End game (practice only).
	// tweakCautiousT: time (s) from which squad mode gives way to the cautious free-for-all parameters for the rest of
	// the match, exactly as a house bot dying without us already does (0 = original: only such a death switches).
	// Keeping squad mode after such late deaths (tweakFFAUntil 60) cost about 0.35, so the cautious mode is used late
	// even in matches where no house bot has died. 265 s is when giddy's own "late" starts (next zone radius 70 m).
	tweakCautiousT = 0.0
	// tweakFinalHold: in the last shrink (radius 25 -> 0 m, 390-415 s, 260 HP/s outside), stay within a tolerance of
	// its end point that shrinks with the circle (original: anywhere within 2 m once the zone deadline is near).
	// The end point is the only spot inside until 415 s; each metre off it in the outward direction is up to
	// 25/(25-L) s earlier outside (L = distance the centre still moves), i.e. several hundred HP, and survivors are
	// then ranked by the order the zone kills them. It holds only in matches confirmed as practice (squad mode on
	// after 60 s; in free-for-all a death we did not cause always ends squad mode before about 37 s).
	tweakFinalHold = false
	// tweakLeadK: squad mode only, gun lead on mechs. A gun shot leaves on the first tick after the decision when
	// the cooldown is at most one tick (else on the second) and covers its first 3 m at once, so the bullet reaches
	// a target d m away (d-3)/speed s after leaving (original: always 0.075 s more). Fighting house bots
	// strafe and turn back, so they cover only part of v*T: the predicted travel is scaled by this factor
	// (0 = original lead; in 123 recorded matches 0.8 best centres bullets on them 0.3-0.6 s ahead).
	tweakLeadK = 0.0
	// tweakLaserSlew: squad mode only. The torso turns before the beam leaves on the first tick after the release,
	// so the release and lethal checks allow one tick of turn; the beam leads its target by that tick
	// (original: 0.125 s); while charging, the aim stays on the gun lead (original: the laser line from 45 % charge
	// on), and gun shots whose bullet would follow the laser line off the gun lead are held.
	tweakLaserSlew = false

	// Free-for-all (outside squad mode).
	// tweakFFASeek: in the first tweakFFASeekT seconds, without a laser or lightning, fetch one up to this distance (m)
	// instead of the loot radius (90 m in free-for-all). In 127 recorded free-for-all matches, with the nearest ground
	// laser/lightning 90-150 m from spawn, giddy-based bots held one at 60 s in 35 % of matches against 61-71 % for the
	// best bots, and a held special weapon at 60 s went with about +3 to +4 points (0 = original).
	tweakFFASeek  = 0.0
	tweakFFASeekT = 60.0
)

// pracSureT: squad mode still on at this time (s) confirms a practice match (see tweakFFAUntil).
const pracSureT = 60.0

type tweakSet struct {
	hopT, loseK, squadT float64
	finish, finishHP    float64
	finishRush          bool
	pursue, stick       float64
	cautiousT           float64
	finalHold           bool
}

// originalTweaks is the 70c8b23 behaviour.
func originalTweaks() tweakSet {
	return tweakSet{hopT: 0, loseK: 1, squadT: 20, finish: 14, finishHP: 0, finishRush: false, pursue: 1.01, stick: 120,
		cautiousT: 0, finalHold: false}
}

// tw holds the tweaks in use (a variable so that tests can compare against originalTweaks).
var tw = tweakSet{
	hopT: tweakHopT, loseK: tweakLoseK, squadT: tweakSquadT,
	finish: tweakFinish, finishHP: tweakFinishHP, finishRush: tweakFinishRush,
	pursue: tweakPursue, stick: tweakStick,
	cautiousT: tweakCautiousT, finalHold: tweakFinalHold,
}
