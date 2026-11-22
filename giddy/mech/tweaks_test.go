package mech

// Offline checks of the tweaks on the kit's recorded stream (check/stream.jsonl.gz, a free-for-all match).
// Run with the kit path in MECHFIGHT_KIT, for example in Docker:
//   docker run --rm -v "$PWD/giddy:/src" -v "<kit>:/kit:ro" -w /src -e MECHFIGHT_KIT=/kit golang:1.26.1-bookworm go test ./mech/

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func kitDir(t *testing.T) string {
	d := os.Getenv("MECHFIGHT_KIT")
	if d == "" {
		t.Skip("MECHFIGHT_KIT not set (path to mechfight-kit)")
	}
	return d
}

type stream struct {
	hello []byte
	obs   [][]byte
}

func loadStream(t *testing.T, kit string) stream {
	f, err := os.Open(filepath.Join(kit, "check", "stream.jsonl.gz"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	var s stream
	sc := bufio.NewScanner(gz)
	sc.Buffer(make([]byte, 1<<20), 1<<22)
	for sc.Scan() {
		line := append([]byte(nil), sc.Bytes()...)
		var p struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(line, &p) != nil {
			continue
		}
		switch p.Type {
		case "hello":
			s.hello = line
		case "obs":
			s.obs = append(s.obs, line)
		}
	}
	if s.hello == nil || len(s.obs) == 0 {
		t.Fatal("empty stream")
	}
	return s
}

type run struct {
	acts        []Action
	modes       []string
	ts          []float64
	panics      int
	notPractice bool
	squadTicks  int
	worst       time.Duration
}

// play feeds the stream (open loop) to a fresh brain using the given tweaks; edit may change each observation.
func play(t *testing.T, kit string, s stream, set tweakSet, edit func(*Obs)) run {
	old := tw
	tw = set
	defer func() { tw = old }()
	var h Hello
	if err := json.Unmarshal(s.hello, &h); err != nil {
		t.Fatal(err)
	}
	w, err := LoadWorld(filepath.Join(kit, "arena"))
	if err != nil {
		t.Fatal(err)
	}
	b := NewBrain(&h, w)
	var r run
	for _, raw := range s.obs {
		var o Obs
		if err := json.Unmarshal(raw, &o); err != nil {
			t.Fatal(err)
		}
		if edit != nil {
			edit(&o)
		}
		t0 := time.Now()
		a := b.Act(&o)
		if dt := time.Since(t0); dt > r.worst {
			r.worst = dt
		}
		if a.Tick != o.Tick {
			t.Fatalf("tick %d answered as %d", o.Tick, a.Tick)
		}
		bad := func(v float64) bool { return math.IsNaN(v) || math.IsInf(v, 0) }
		if bad(a.Move[0]) || bad(a.Move[1]) || math.Hypot(a.Move[0], a.Move[1]) > 1.0001 {
			t.Fatalf("tick %d: bad move %v", o.Tick, a.Move)
		}
		if a.Aim == nil || bad(a.Aim[0]) || bad(a.Aim[1]) {
			t.Fatalf("tick %d: bad aim %v", o.Tick, a.Aim)
		}
		if _, err := json.Marshal(a); err != nil {
			t.Fatalf("tick %d: %v", o.Tick, err)
		}
		if b.pracOn {
			r.squadTicks++
		}
		r.acts = append(r.acts, a)
		r.modes = append(r.modes, b.Mode)
		r.ts = append(r.ts, o.T)
	}
	r.panics, r.notPractice = b.Panics, b.notPractice
	if r.panics > 0 {
		t.Fatalf("%d panics recovered", r.panics)
	}
	return r
}

func diffTicks(a, b run) (n int, first float64) {
	first = -1
	for i := range a.acts {
		if !reflect.DeepEqual(a.acts[i], b.acts[i]) {
			if n == 0 {
				first = a.ts[i]
			}
			n++
		}
	}
	return
}

func modeCount(r run) string {
	c := map[string]int{}
	for i, m := range r.modes {
		k := m
		if r.acts[i].Boost {
			k += "+boost"
		}
		c[k]++
	}
	var ks []string
	for k := range c {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	var sb strings.Builder
	for _, k := range ks {
		fmt.Fprintf(&sb, "%s=%d ", k, c[k])
	}
	return sb.String()
}

// TestParams70c8b23 pins the free-for-all base and the original squad parameters.
func TestParams70c8b23(t *testing.T) {
	want := Params{RetreatHP: 0.38, RecoverHP: 0.8, GunRange: 85, LightRange: 28, LaserRange: 85, EngageDist: 60, FarmNPC: true,
		Ghost: true, HomeExpo: 120, LootRadius: 90, CrateUntil: 150, Dodge: true, NoMortar: true,
		Peek: true, LaserFirst: true, CrowdHide: true, Practice: true}
	if got := DefaultParams(); got != want {
		t.Fatalf("DefaultParams changed (free-for-all base):\n got %+v\nwant %+v", got, want)
	}
	old := tw
	tw = originalTweaks()
	defer func() { tw = old }()
	sq := want
	sq.Ghost, sq.Peek, sq.LaserFirst, sq.LaserRange, sq.LootRadius, sq.CrateUntil = false, false, true, 120, 150, 1e9
	sq.Stick, sq.HPw, sq.LowBonus, sq.MaxTarget, sq.LoseRule, sq.FightLoot, sq.FarmHP = 120, 0.2, 100, 240, true, 70, 0.5
	sq.LaserSeek, sq.LaserUp, sq.Lethal, sq.Finish, sq.Pursue = 240, true, true, 14, 1.01
	if got := squadParams(DefaultParams()); got != sq {
		t.Fatalf("squadParams with original tweaks differs from 70c8b23:\n got %+v\nwant %+v", got, sq)
	}
	t.Logf("tweaks in use: %+v", old)
}

// TestFreeForAllUnchanged: on the recorded free-for-all match the tweaks in use must play exactly like 70c8b23.
func TestFreeForAllUnchanged(t *testing.T) {
	kit := kitDir(t)
	s := loadStream(t, kit)
	ref := play(t, kit, s, originalTweaks(), nil)
	ref2 := play(t, kit, s, originalTweaks(), nil)
	if !ref.notPractice || ref.squadTicks > 0 {
		t.Fatalf("free-for-all not detected (notPractice %v, squad ticks %d)", ref.notPractice, ref.squadTicks)
	}
	noise, _ := diffTicks(ref, ref2)
	cur := play(t, kit, s, tw, nil)
	n, first := diffTicks(ref, cur)
	t.Logf("%d obs, worst step %v; original vs original: %d ticks differ; original vs tweaks: %d differ (first at t=%.1f)",
		len(s.obs), cur.worst, noise, n, first)
	if noise == 0 && n > 0 {
		t.Fatalf("the tweaks change free-for-all play: %d ticks differ, first at t=%.1f", n, first)
	}
	if n > 2*noise+3 {
		t.Fatalf("the tweaks change free-for-all play beyond run-to-run noise: %d vs %d", n, noise)
	}
}

// TestSquadStream: the same match turned into a practice-like one (nobody else dies, so the squad parameters
// take over after 20 s; our HP held at 60 % and enemy HP scaled down so that the lose rule and the finishing
// code run). No panics or bad actions, identical play before the squad switch.
func TestSquadStream(t *testing.T) {
	kit := kitDir(t)
	s := loadStream(t, kit)
	edit := func(o *Obs) {
		o.Alive = 16
		o.Self.HP = math.Max(o.Self.HP, 0.6*o.Self.MaxHP)
		for i := range o.Mechs {
			if o.Mechs[i].Kind == "mech" {
				o.Mechs[i].HP *= 0.3
			}
		}
	}
	ref := play(t, kit, s, originalTweaks(), edit)
	cur := play(t, kit, s, tw, edit)
	if ref.notPractice || ref.squadTicks == 0 {
		t.Fatalf("squad mode not reached (notPractice %v, squad ticks %d)", ref.notPractice, ref.squadTicks)
	}
	n, first := diffTicks(ref, cur)
	t.Logf("squad ticks %d/%d, worst step %v; %d ticks differ from 70c8b23 (first at t=%.1f)", cur.squadTicks, len(s.obs), cur.worst, n, first)
	t.Logf("70c8b23 modes: %s", modeCount(ref))
	t.Logf("tweaks  modes: %s", modeCount(cur))
	if tw.hopT == 0 && n > 0 && first < math.Min(tw.squadT, 20) {
		t.Fatalf("play differs before the squad switch (t=%.1f)", first)
	}
}

// TestEndGame: the same match moved to 380-417 s of a practice match (nobody else dies) inside the last zone phase:
// a 25 m circle holding until 390 s, then shrinking to radius 0 at 415 s on a point 5 m east of us, whose centre
// starts 15 m east of us. With tweakCautiousT and tweakFinalHold on, squad mode must end at once and we must hold
// the end point; with the original tweaks neither happens. No panics or bad actions either way.
func TestEndGame(t *testing.T) {
	kit := kitDir(t)
	s := loadStream(t, kit)
	edit := func(o *Obs) {
		o.T += 380
		o.Alive = 16
		o.Self.HP = math.Max(o.Self.HP, 0.6*o.Self.MaxHP)
		x, y := o.Self.Pos[0], o.Self.Pos[1]
		f := clamp((o.T-390)/25, 0, 1)
		cx, cy := x+15-10*f, y
		r := 25 * (1 - f)
		o.Zone = Zone{Center: [2]float64{cx, cy}, Radius: r, NextCenter: [2]float64{x + 5, y}, NextRadius: 0,
			ShrinkStart: 390, ShrinkEnd: 415, Dps: 260}
		o.Self.InZone = hyp(x-cx, y-cy) <= r
	}
	on := tw
	on.cautiousT, on.finalHold = 265, true
	for _, c := range []struct {
		name string
		set  tweakSet
	}{{"original", originalTweaks()}, {"end game on", on}} {
		r := play(t, kit, s, c.set, edit)
		final, east := 0, 0
		for i, m := range r.modes {
			if m == "final" {
				final++
				if r.acts[i].Move[0] > 0 {
					east++
				}
			}
		}
		t.Logf("%s: notPractice %v, squad ticks %d, final ticks %d (%d moving east); modes: %s", c.name, r.notPractice,
			r.squadTicks, final, east, modeCount(r))
		if c.set.finalHold {
			if !r.notPractice || r.squadTicks > 1 {
				t.Fatalf("%s: squad mode not ended by tweakCautiousT (notPractice %v, squad ticks %d)", c.name, r.notPractice, r.squadTicks)
			}
			if final == 0 || east*2 < final {
				t.Fatalf("%s: end point not held (%d final ticks, %d moving east)", c.name, final, east)
			}
		} else if r.notPractice || final > 0 {
			t.Fatalf("%s: end-game code ran with the original tweaks (notPractice %v, final ticks %d)", c.name, r.notPractice, final)
		}
	}
}
