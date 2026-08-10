# Moving and resizing a video during a presentation

Status: proposed.

## Goal

Let a video change position and size across presentation steps, the way
any other shape does — and, in doing so, replace the workaround that
made videos a special case in the first place. Playback stays smooth
across the move: the same player keeps playing, at the same position in
the video, while its frame travels.

A video _shape_ does not need to be a player. That relaxation is what
makes the rest of this design possible, and it is the one thing the
reader should carry into every section below. Editing keeps a live,
interactive player — just one per video, owned by the runtime rather
than by any shape.

## Why the current shape of the feature exists

The v2 animation model expresses "this shape is here at step 2, and
there at step 5" by carrying each keyframe on a **copy** of the shape.
Navigation switches which copy is visible, and a temporary clone tweens
between them.

For a video that mechanism is unusable: a copy is a second
`youtube-embed`, and a mounted `youtube-embed` is a live iframe. Two
copies means two players competing for the same video, and switching
visibility between them at a step boundary would restart playback
exactly when it should continue.

Everything that currently makes videos special descends from that one
fact — the `media-control` marker shape (a frame carrier that is _not_
a copy of the video), the `media-control` binding that ties it back,
the withheld follow-up-frame buttons, and the video's exemption from
the latest-frame-of-batch visibility rule.

## The idea

**Stop mounting a player per shape.** Video shapes render a static
poster; exactly one live player exists per video, owned by the runtime,
positioned to follow whichever shape currently represents that video —
in presentation mode and while editing alike.

Once a video shape is no longer a player, a copy of it is harmless, and
the special case collapses:

- Keyframes become **ordinary copies**, like every other animated
  shape. Drag & drop, the follow-up-frame buttons, duplicate-remap and
  paste all apply unchanged, with no new authoring UI to build.
- The player never remounts, because it is never owned by a shape that
  can be hidden, replaced or re-created. The class of bug that produced
  the reconnect and re-render remounts cannot recur here.
- The video's exemption from the visibility rule goes away: with real
  copies on the track, the latest-frame-of-batch rule is correct again.

### Where the player lives

`components.OnTheCanvas` renders inside `tl-html-layer tl-shapes`, the
element that carries the camera transform (`InFrontOfTheCanvas` is
outside it). A player placed there is positioned in page coordinates
and inherits pan, zoom and `cameraZoom` animation for free — the same
way a shape does, and without the store learning anything about it.

The camera is all the layer provides; the rest of the carrier's
rendering context is mirrored explicitly. tldraw styles each shape's
container from the same small set of computed values — the full page
transform (`getShapePageTransform`, so ancestor rotation and group
movement are included), the geometry bounds' width and height, the
clip path (`getShapeClipPath`, which is how frame masks apply), the
composed opacity, and a `z-index` that mirrors the shape's position in
the page's sorted shape order — the order the renderer itself is fed,
and one that is defined for every shape whether or not it is currently
rendered, so hiding a carrier does not unmoor the player's layering.
Shape containers are stacked as siblings by `z-index`, so a player
container subscribing to the same values of its anchor carrier sits in
the same stacking context: a video inside a frame is clipped by the
frame, a shape drawn above the video occludes the live player, and a
keyframe with a different size resizes the player — the iframe fills
its container, so the embedded player rescales with no API
involvement. One tie needs breaking explicitly: `OnTheCanvas` renders
before the shapes in the DOM, and equal-z-index siblings stack by DOM
order, so a player merely sharing its carrier's `z-index` would be
painted over by that carrier's own poster. The anchored carrier
therefore suppresses its poster while its player is mounted — the
player _is_ that carrier's visual — which dissolves the pair's
ordering question entirely; against every other shape, the shared
`z-index` alone stacks the player correctly.

Painting and hit-testing are separate arrangements, and suppressing
a poster removes pixels but not a hit box: the carrier's container
is still the later sibling, so it would swallow clicks aimed at the
iframe beneath it. Pointer input is therefore held by exactly one of
the pair at a time, swapped together with the interaction modes
described under Editing. While the player is idle it is
`pointer-events: none` and the carrier takes input, so selecting,
dragging and resizing stay ordinary canvas gestures; while the
player is interactive the anchored carrier is `pointer-events: none`
and the player takes input, so the video's own controls are
reachable. Browser-level tests cover both arrangements: one stacks
shapes immediately above and below the carrier and asserts the
player paints exactly where the carrier would; another clicks and
focuses real iframe controls through the overlapping carrier, and
drags the carrier while the player is idle.

During a step tween the transform and the width/height interpolate
between the outgoing and incoming carriers' stored values, opacity and
`z-index` follow the incoming carrier, and the clip path is dropped
for the duration, the incoming carrier's mask applying when the tween
lands. Unclipped travel is not a compromise; it is what every other
animated shape already does — the tween clone is created as a
page-level shape, outside any frame's mask, and the destination mask
takes over only when the real carrier appears on arrival. A video
moving into, out of, or between frames behaves like any shape making
the same move.

Which carrier the player anchors to is explicit runtime state, never
derived from what happens to be rendered. Carrier visibility exists to
show posters; the player's placement cannot follow it, because during
an animated step there is no visible carrier at all — `runStep` hides
the incoming frame's carrier for the length of the tween, and the
outgoing one has stopped being current. The runtime moves the anchor
through three states:

- **Steady, presenting.** The anchor is the carrier the visibility
  rule shows, and the player mirrors its values.
- **Tweening.** Advancing a step re-points the anchor at the incoming
  carrier and interpolates transform and size from the outgoing
  carrier's stored geometry to the incoming one's. Both records are
  hidden while this runs; the runtime reads stored values, not
  rendered state, and the mirrored opacity is the carrier's own
  composition without the presentation hiding — the player _is_ the
  video's visible representation while its carriers are not.
  Cancelling, jumping, or navigating away mid-tween drops the anchor
  to the folded target directly, per the reconciliation rule below.
- **Editing.** Every carrier is visible, so a fixed rule takes over:
  the anchor is the carrier of the sequence's earliest keyframe — the
  video's starting position — and an unanimated video is its only
  carrier. Deleting or reordering keyframes re-evaluates the rule.
  Entering a carrier's editing state overrides it for the duration:
  the double-clicked carrier becomes the anchor before pointer input
  reaches the player — re-anchoring is a style change, never a
  remount, so this costs nothing — and the default resumes when
  editing ends, so every visible keyframe is a place the video can
  actually be controlled from. A browser test double-clicks a
  non-earliest keyframe and drives the player there.
- **Absent.** Before a video's cue step, after a backward jump to a
  step before it, or once every carrier is gone, the fold yields no
  anchor at all. The governing invariant is continuous and admits no
  window: **a mounted iframe is never hidden**, because a mounted
  iframe can be restarted by the media-session channel with no
  observable notification, and any hidden interval — however brief —
  is an interval in which that restart produces audio nobody can
  see or stop. So Absent for a restorable player means teardown: the
  pause is attempted, and on confirmation — or on the bounded
  retry's expiry — the iframe is removed, nothing mounted being
  nothing restartable, and the next advance remounts it by clock.
  Absent for an unrestorable player means staying visible: the
  compact viewport chip described below, interactive for the entire
  mounted lifetime. A browser test fires a media-session play with
  its notification withheld at every point of the Absent lifecycle
  and proves no moment exists where playback is hidden and
  uncontrollable. The chip is a small "still playing / paused"
  control anchored to the viewport rather than to any carrier, with
  two fully defined actions: retry the pause, and **Stop** —
  explicitly destructive, tearing the iframe down behind a warning
  that the live position will be lost. It cannot be hidden while its
  player is mounted, disappearing only with a Stop or teardown;
  stray UI beats an audible ghost, and losing a live position is a
  choice the user makes, not one the runtime makes for them.
  Browser tests withhold the pause acknowledgement for a restorable
  player (torn down at retry expiry) and a live one (chip stays,
  never unmounted). The player leaves Absent the moment the fold
  yields an anchor again — a restorable one by clock-guided remount,
  an unrestorable one by dissolving its chip back into the anchored
  player.

A change of anchor only changes which shape's values the player
mirrors, never the player's place in the DOM, so it cannot remount the
iframe — which is what made every re-anchoring scheme on shape-mounted
players unsafe.

One existing mechanism must stand aside for this to work: `runFrames`
animates an ordinary `shapeAnimation` by minting a temporary
page-level clone and tweening it. Video keyframes opt out of exactly
that step — their frames keep duration and easing, so step timing is
untouched, but no clone is minted, because the runtime player is the
moving representation and a cloned poster would visibly ride the same
path beside it. Skipping the clone also keeps identity clean: no
transient shape carrying a `videoKey` ever exists, so carrier
counting, authority transfer, and orphan cleanup can never observe a
phantom carrier. A presentation-level regression test plays a
movement step and asserts exactly one moving video is visible.

Viewport culling is deliberately not mirrored — hiding a live player
because its carrier scrolled away is the remount hazard again — but
a player whose carrier has left the viewport is offscreen, and
offscreen is a form of hidden: if it plays, or the media-session
channel restarts it, that is again audio nobody can see or stop. The
Absent state's rule therefore extends to it, since it is the same
rule — and it extends by *mounting*, not by play state. Tying the
chip to observed playback would leave a paused offscreen player
chipless, and a media-session restart with its notification withheld
would then be audible with nothing to stop it; the runtime cannot
learn it needs a control until after the harm. So every mounted
player whose carrier is out of view carries the compact viewport
chip for its entire offscreen lifetime, paused or playing, with the
same pause and **Stop** actions, dismissed only when the carrier
returns or the player is torn down. Several offscreen at once
collapse into one grouped chip, so the cost is a single small
affordance rather than clutter. The invariant "no mounted player
without a reachable control" then holds continuously and without
needing to know what the player is doing. A browser test starts from
a paused, offscreen player, fires a media-session play with its
notification withheld, and asserts a control was reachable
throughout. Culling answers visibility, not cost. One player per video still
means a document with many videos could mount many iframes, so
mounting is governed by two explicit limits, both host-configurable:
at most P simultaneously playing players (default 4) and at most M
mounted players (default 6), the single validated invariant being
M ≥ P. Headroom above P is what buys the graceful pause-then-evict
path, so the default provides it; M = P is a supported
zero-headroom mode whose one named difference is that an overflow
play is refused outright rather than displacing a player. Mounts are
granted in priority order: effectively playing, then selected, then
near the viewport. Everything over the mount budget shows its
poster.

An effectively playing player is **never unmounted except where
restoration is defined**, and the two halves of that sentence are
the whole contract. For unrestorable content — live, unknown
duration, a failed seek — it is absolute: nothing but the user's
explicit Stop removes such a player, because nothing could put it
back. For restorable content it is a bound rather than a
prohibition: an unmount may happen only on the named paths below
(ambiguous-pause slot turnover, strict `pauseOnHidden`), never to
make room, and it costs at most the clock's staleness — one settle
window of drift, since the clock is refreshed on every poll and on
every command — after which the player remounts and seeks back,
landing exactly where the seek succeeds and approximately where it
does not.
Eviction and reconstruction cannot preserve everything an iframe
holds, buffers and captions among it, and uninterrupted playback is
the guarantee this whole design exists for, so the mount budget is
never spent on a playing player as a matter of ordinary policy; the
named paths are failure handling, not capacity management. The playing limit is enforced ahead of
that moment instead: authoring warns when a step would drive more
than P simultaneous playing videos, presentation start surfaces the
same check, and the runtime enforces P by admission, not reaction:
every programmatic play — event-driven or UI-driven — synchronously
reserves a play slot before the command is issued. When the
reservation needs a slot freed, the least recently started playing
video is sent its pause *in place* — a pause preserves the iframe
and all of its state where an unmount destroys it — but the slot is
not free yet: `pauseVideo` is a void command to an iframe that
reports state asynchronously, so the slot stays occupied and the
replacement play stays queued until a non-playing state is
confirmed, with a timeout that surfaces a stuck player rather than
assuming it stopped. Eviction obeys the same confirmation — nothing
unmounts until its reported state is non-playing — so a logically
paused but still-playing iframe can neither breach P nor be
destroyed mid-playback; tests deliver pause confirmations late,
never, and out of order. The paused player stays mounted while M
allows. The one edge
admission cannot reach is the iframe's own controls: a manual play
arrives as an asynchronous state-change notification, and one that
would exceed P is reverted immediately, paused back with a surfaced
notice, never displacing another player. Reversion itself can fail —
`pauseVideo` carries no correlated acknowledgement, and an
unrestorable player cannot be torn down — so the overflow policy has
a defined terminal form rather than an assumed convergence: if the
corrective pause cannot confirm within its bounded retry, enforcement
escalates to pausing (or, on ambiguity, tearing down) a *restorable*
playing player instead, restoring the count at the cost the
restorability predicate already prices; and only when every playing
player is unrestorable with an unconfirmable pause does the budget
yield — explicitly, the contract weakening to a surfaced persistent
overflow in which each excess stream carries its viewport chip and
Stop, because silently destroying live positions the user started is
the one resolution off the table. A live-stream test times out the
corrective pause while the position keeps advancing and asserts the
escalation, then the surfaced yield. Because notifications are
asynchronous and up to M players sit mounted, several native plays
can start before any notification lands: P is therefore a hard limit
for everything the runtime issues and a soft one against native
controls, transiently exceedable by at most M − P, every excess play
reverted as its notification arrives. A host that needs an absolute
cap sets M = P, the zero-headroom mode described above. Tests fire simultaneous
programmatic plays together with several native starts delivered
before any notification, not only the eventual post-overflow state.
When M presses, the longest-paused *evictable* player is evicted —
evictable meaning restoration is confirmable: a positive, finite
duration has been observed and the content seeks. Live streams,
unknown-duration players, and any player whose restore-seek has
previously failed are not evictable and stay mounted; if M presses
with no evictable candidate, the new mount is refused — its carrier
keeps the poster, with a notice — because refusing a new player is
recoverable and jumping an unseekable stream is not.

That predicate is retrospective, though: having seen a duration and
a successful seek does not promise the *restoring* seek will land,
and a teardown that has already happened leaves no copy of the
position to fall back on. The tempting answer — stage the
replacement, confirm its position, then destroy the original — is
not available here, because a staging iframe is a mounted iframe:
it would sit unanchored, with no carrier to show and no control to
reach, and the media-session channel can restart any mounted iframe
without notification. That is precisely the hidden, uncontrollable
playback the design forbids, and it would put two live players
behind one video. No property of the embed API can rule it out, so
the concurrent handoff is rejected rather than papered over.

What follows is that destruction is never a way to make room, and
the resolution order says so: refusal first, destruction only where
refusal is not available. When M presses, an ambiguous or
unrestorable candidate means the new mount is refused and the
runtime under-admits — the poster stays, with a notice — rather than
trading a live position for capacity. Teardown is left to the two
places where nothing else will do: an ambiguous pause holding a slot
the user's own action needs, and strict `pauseOnHidden`, which
exists to silence a hidden page. In both, restoration is by clock
and therefore best-effort: the remount seeks to the saved position,
and where that seek does not land the player resumes at the position
the content offers, with the discontinuity surfaced rather than
silent. That is the honest bound — exact where the player was
paused and the seek lands, approximate when it does not, never
applied to unrestorable content at all — and it is what "restoration
is defined" means in the invariant above. The
testable contract is stated once, without an absolute it cannot
keep: runtime-issued playback never exceeds P; native playback may
exceed P, bounded by M − P, and every excess reverts as its
notification arrives — transiently in every case except the terminal
one named above, where all playing players are unrestorable and no
corrective pause confirms, in which the excess persists, bounded by
the same M − P, until the user acts on a surfaced chip; mounted
players never exceed M; and no player is unmounted except where
restoration is defined. A host that needs convergence to P as a
resource or policy guarantee gets it by refusing unrestorable
content, since that terminal state cannot arise without it. A
contract test drives the all-unrestorable, unconfirmable-pause case
and asserts the surfaced overflow and its bound. The headroom between P
and M is what buys the graceful pause-then-evict path; a fixture
repeats overflow plays past both limits. Non-playing
residency is sticky: eviction by viewport distance uses a margin and
a minimum residency time, so panning the camera reorders candidates
without thrashing mounts.

The budget suppresses mounting; it never rewrites desired state.
Desired playback folds from events identically on every client, and
the mounted set is a pure function of the folded states, the overlay
below, and the priority order, so it changes only when they do and
cannot oscillate on its own. Manual interaction joins as a
client-local overlay: the runtime already hears the player's
state-change events, and a manual pause or play recorded there
combines with the folded status into an _effective_ status. A manual
overlay is cleared only by a media command targeting that video —
the one moment the fold deliberately retakes control — and survives
navigation that carries no such command: a movement-only step must
not resume a video the user paused, or "does not resume behind the
user's back" would mean nothing. A budget pause is cleared by a
media command or by the user's own play; a freed slot never
auto-resumes anything — it merely permits resumption, which the
control surface invites from the held position. Priority and the playback clock
read the effective status, and tests navigate through steps with and
without media commands over a manual pause.

Distinguishing the user's hand from the runtime's own commands is
never left to per-notification inference, because the iframe reports
both identically and confirmations can arrive late or out of order.
Each player runs one serialized transition state machine with four
separated registers: desired state, from the fold; issued and
unconfirmed commands, a queue; confirmed iframe state, from
notifications; and native interaction, the residue. A notification
is matched against the pending-command queue by **expected
transition**, never by timing: a command predicts the specific state
it produces — pause predicts paused, play predicts playing — and
consumes only a notification of exactly that state. Autonomous
transitions — buffering, ended, errors — update confirmed state and
are never read as intent or as acknowledgement. A matching
notification still cannot say *who* caused it, so during pendency
native input is actively excluded rather than assumed away: the
runtime disables pointer input and moves focus off the cross-origin
iframe onto the player container, so a keyboard pause cannot reach
the player while a pause command awaits its acknowledgement — a
browser test types at a previously focused player during pendency
and proves the keystroke lands on the container, and another
delivers a same-direction native action against a pending budget
pause and proves manual-pause persistence and slot accounting stay
correct. Two channels remain that no exclusion covers — the
browser's media session, whose hardware play/pause keys no web page
can intercept from outside the iframe's origin, and the ordering
where a native action lands just *before* a same-direction command
whose pendency then swallows the notification. Rather than guess at
attribution in either, the conservative resume rule swallows both:
**every pause acknowledgement is marked possibly-manual**, because a
hardware or just-in-time user pause can coincide with any pending
pause and no query can say who paused; and a possibly-manual pause
is never auto-resumed. It resumes only on an explicit media command
or the user's own play, with the control surface showing "paused —
resume" instead of resuming behind the user's back — which is why
freed slots never auto-resume at all. Slot accounting is unaffected,
since paused is paused whoever caused it; the cost is bounded and
benign — a budget-paused video waits for a click it may not have
needed. Tests fire a native pause immediately before a budget pause
with its notification delivered during pendency, and a hardware
pause coinciding with a pending budget pause, verifying a freed slot
resumes neither. A notification that contradicts the
pending command — a pause while play is pending, whether a late
acknowledgement of something earlier or a user's keystroke — is
consumed by neither register; it drops the player into
**reconcile**: the runtime stops issuing commands to it, gathers the
temporal corroboration described below — spaced playback-position
reads, since the state getter merely echoes the same message channel
— rebuilds confirmed state and slot accounting from that evidence,
and re-derives intent conservatively, treating a video observed
paused that the fold wants playing as manually paused, the harmless
direction. Command timeouts land in the same reconcile path.

Nothing irreversible moves on a notification alone — and nothing
moves on `getPlayerState()` alone either, because that getter is fed
by the same asynchronous message channel as the notifications and
can only echo what the iframe last sent; treating it as independent
confirmation would be circular. Before a slot is freed, a
replacement play issued, or an eviction admitted, the runtime
demands corroboration that is *temporal*, not cached — and the
evidence is asymmetric. An advancing playback position across spaced
reads proves the player is playing, because a stale cache does not
keep moving; it always blocks release. A frozen position proves
nothing: a stale cache, a buffering player, and a genuinely paused
one all freeze identically, so a frozen pair alone never frees a
slot and never admits an eviction — and no conjunction of ambiguous
signals is promoted into proof, because a delayed same-state
notification over a buffering-frozen position is observationally
identical to a real pause, and no prototype can split identical
observables. Release therefore rests on certainty or does not
happen — and the design's baseline assumes no unproven primitive.
**Teardown** — removal of the iframe, causally certain because a DOM
node that no longer exists cannot play — is the ground of release
that always exists. How *promptly* removal stops media is a browser
question, not a logical one: detachment may precede the teardown of
the underlying media pipeline, so the prototype milestone below must
establish, across supported browsers, when a detached cross-origin
iframe actually goes silent. Until it does, the slot released by a
teardown passes through a **retiring** state for a conservative
drain interval before it is granted, so a replacement play cannot
overlap a still-sounding predecessor; if the prototype shows
cessation is prompt, the drain collapses to zero and the release is
immediate. Either way the hard-P contract is kept by construction
rather than by assumption. With that, teardown is the release: baseline slot turnover for a
restorable player attempts the pause for a grace period, then
transfers the slot by teardown, and the torn-down player resumes by
its clock exactly as an evicted one does. Pause-in-place with the
iframe preserved is an *enhancement*, unlocked only if the IFrame
API browser prototype — a blocking implementation milestone
alongside the sync fork's, tasked with naming the exact observable
that establishes causality, with measuring the teardown drain
above across supported browsers, and with exercising remount-and-seek
across content states so the clock-guided restore's accuracy rests
on measured behavior — proves a genuinely command-correlated
acknowledgement exists. Failure injection covers metadata that
changed between mount and remount, a remount whose seek fails, and
a saved position the content will not accept. If it finds none, the baseline stands
complete on teardown and under-admission alone, and the continuity
guarantees are read against that baseline. When evidence stays ambiguous past the settle
window, the runtime does not guess — and teardown obeys the same
restorability predicate as eviction. If the slot is needed and the
ambiguous player is restorable — finite duration observed, seeking
confirmed — the runtime tears it down and takes the certainty
teardown grants: a bounded, named loss, since a player whose
playback was unobservable for the whole window loses little and
remounts later by its clock exactly as an evicted one would. If the
ambiguous player is *not* restorable — live, unknown duration, a
failed seek — ambiguity always fails closed: the replacement play is
refused with a surfaced notice or queued, and the existing player is
never unmounted, because the only thing worse than refusing a new
video is destroying a live position nothing can restore. If the
slot is not needed at all, the runtime simply under-admits. Either
branch keeps both guarantees as stated above: no admission ever
exceeds P, and no player is unmounted except where restoration is
defined — never an unrestorable one, and a restorable one only for
a bounded clock loss. The regression scenario runs an old pause notification,
a later pause command, a buffering-frozen position, and a delayed
buffering notification, and asserts the slot frees only through
teardown; its live-stream variant has an unrestorable player never
acknowledge a budget pause and asserts the replacement is refused
with the player intact. A test also delivers an old paused notification during a
later pause while the position keeps advancing, and asserts no slot
frees and no eviction occurs. Tests
interleave programmatic plays, budget pauses, and native clicks with
late and out-of-order notifications, asserting the overlay and the
slot accounting both land right; browser tests add keyboard input
into a focused iframe during pendency, autonomous buffering and
ended transitions, and a timed-out acknowledgement arriving during a
later command.

When suppression lifts, the player mounts and seeks by the runtime's
playback clock: a per-video (position, observed-at, rate) triple,
refreshed by periodic polls while a player is mounted and on every
pause, seek, rate change and eviction — the rate comes from the
player's own rate-change events, since interactive controls let a
viewer set 0.5x or 2x. Because a playing player is never evicted, an
evicted video's clock is always a paused one: it holds its position
and the remount seeks exactly there — no virtual advancement, no
duration arithmetic, nothing to misjudge for live streams or videos
whose metadata has not arrived. Buffering is not modeled: the clock
is best-effort continuity, resynced by the polls whenever a player
is mounted. Those polls double as liveness for the budget: every
mounted player's actual state is queried on the same cadence, and an
observed state the registers cannot explain — a native play whose
notification never arrived — reconciles immediately, budget
enforcement included. A poll interval is not a wall-clock bound and
the design does not claim one: browsers throttle timers in
background pages while iframe media plays on, so reconciliation also
runs on `visibilitychange`, on page resume, and before any command
is issued, bounding stale accounting by the page's own lifecycle
transitions rather than by a timer the browser may freeze. The hide
transition itself enforces once more: on `visibilitychange` to
hidden — an event browsers do deliver at that moment — the runtime
reconciles all mounted players and pauses any playback above P. One
channel remains beyond any page's reach, and the contract says so
instead of pretending: a native or media-session play that starts
*after* the page is hidden and whose notification never arrives
cannot be observed until the next lifecycle event, so background
overflow from that channel is bounded by the user's return, not by
the runtime. A host that cannot accept it enables strict
`pauseOnHidden`: every *restorable* player is unmounted at the hide
transition, so post-hide native playback is impossible for them
because no iframe exists to play — a pause command would not close
the channel, being asynchronous and revocable by a later native
start — at the stated price that continuity across hide-and-return
is reduced to a clock-guided remount. Unrestorable players are
outside even strict mode's reach, by the same invariant that governs
every teardown: destroying a live position without the user's
explicit Stop is never on the table, so they receive the pause
attempt and stay mounted, and strict mode's bound is honest rather
than absolute — hard for everything restorable, while a live stream
the user set playing may persist until they return. A host needing
the absolute bound pairs strict mode with the `allowLive` content
policy and simply does not embed unrestorable media. A browser test
hides and returns while a live player is confirmed playing and
asserts it was neither unmounted nor silently stopped.
Tests start native plays whose notifications are delayed
indefinitely or never delivered, including one beginning after
backgrounding, across a background throttle and resume. The clock is deliberately
client-local — media events carry commands, not positions, and what
folds identically everywhere is the status. Fixtures cover eviction and remount at non-default
rates, for live video, before duration metadata has arrived, and the
over-limit path: an over-limit play pausing the oldest in place,
the freed slot inviting — never forcing — resumption from the held
position.

Keeping the store out of it is the reason not to animate the video
shape directly. Writing `x`/`y`/`w`/`h` during playback would put
presentation state into the document: on a synced deck every
intermediate frame broadcasts
to collaborators, an interrupted presentation leaves the video
displaced, and `bailToMark` — which is how the current animation code
suppresses history — would fight the animation. Runtime state belongs
where the desired playback state already lives: outside the document.

### What the runtime tracks

Per video, the runtime already holds a desired **playback** state
(playing/paused, muted, volume) folded from the event history. This
adds a desired **transform** — position, size and rotation — folded
the same way from the keyframe history:

- Advancing one step tweens the transform over the frame's `duration`
  with its `easing`, alongside the existing animation.
- A jump or a backward move reconciles it directly to the folded value,
  with no tween — the same rule `foldMediaPlaybackStates` follows, for
  the same reason.
- Leaving presentation mode clears it, like `pauseAll`.

## Identity: `videoKey`

A moving video is several shapes. Something has to say "these carriers
are one video", and media events have to name the video they act on.

`trackId` is the wrong answer. A track says _which animation sequence_
a keyframe belongs to; a video that is visible from the start and only
receives media events has no animation at all, and so no track, while
still being a perfectly valid subject for `play` and `pause`.

So the video carries its own identity: a **`videoKey` prop**, minted
when the video is placed — as the placing shape's own id, a choice the
configuration-owner rule below leans on.

- **`videoKey`** — which video instance this is. Keys the live player,
  and is what a media event targets.
- **`trackId`** — which animation sequence a keyframe belongs to.
  Present only when the video is animated.

Carriers of one video share both. An unframed video has a `videoKey`
and no track. The two questions stop being entangled.

The duplicate-vs-rejoin distinction comes for free: the
follow-up-keyframe path is ours and preserves `videoKey`, while
`Cmd+D` and paste run through the remap wrapper, which mints a fresh
one alongside the fresh `trackId` — the new id of the copied
key-named carrier when it is among the copies, and the smallest new
id otherwise. Normalization happens at serialization, while the
source store is still in hand: copying or duplicating resolves the
source video's authoritative values and writes them, at a fresh
revision, onto the payload's new owner — so even a paste into another
document, where the source owner never existed, carries the source's
current configuration rather than a stale keyframe's raw props.
Duplicating a video therefore yields an independent video with its
own player, which is what the gesture implies.

### One video, one configuration

Sharing an identity means sharing a configuration. A carrier copy
carries all of the video's props, and `url`, `videoId`, `start`,
`muted`, `controls` and `altText` describe the video, not a keyframe
— two carriers of one `videoKey` disagreeing on `videoId` is
incoherent. (The `url` prop the URL form round-trips is part of the
set: leaving it carrier-local would let a stale keyframe's form
resubmit an old video selection.)

The invariant needs an owner, not symmetric mirroring: copying edits
in both directions between records only converges by luck under
concurrent sync, where each side's mirror writes race the other's on
the same properties of different records. Nor can the owner be
"whichever carrier is currently earliest" — keyframe order is itself
synced mutable state, so two clients mid-reorder can disagree about
the owner and land edits on different records. The same objection
kills any rule that reads structure, "the smallest surviving id"
included: a concurrent copy or deletion moves it.

So authority follows the data instead of the structure, and it is
tracked **per property**, not per carrier. Alongside the media props,
each carrier holds a revision map — per media prop, a Lamport stamp:
a counter plus the stable id of the editing session that wrote it —
and every property of a video's configuration resolves independently:
the `videoId` read is the `videoId` carrying the highest stamp,
counters compared first, exact ties broken by session id. Stamps are
globally unique, so the order is total and no residue is left for
delivery or retry timing to decide; a carrier-id tiebreak would not
be, because edits are deliberately routed to the same carrier — two
offline clients editing one prop from counter N both write N+1 to
the same record, and only the session id separates them. An edit
writes the edited props, each stamped one past its highest seen
counter, and may land on any carrier — by convention the key-named
shape while it lives, the smallest id otherwise — because
correctness never depends on which record holds a value, only on the
stamp it travels with. Props never stamped resolve from the
key-named carrier, then the smallest id; unstamped values are birth
copies, identical wherever they sit. The same total order governs
reads, transfers, undo's still-resolves check, the server's
regression guard, and the pre-release's stamping.

In a shared room, client-authored stamps are provisional, not
authoritative. The pre-apply hook is a single serialization point,
and it re-stamps every admitted media-prop **edit** with a
server-issued stamp — the room's next counter for that prop, paired
with the authenticated principal — discarding whatever the client
claimed. Edit is a classification the hook makes explicitly, not a
synonym for write: creating a same-key keyframe carrier writes
copied media props by design, and those arrive with — and must keep
— an empty revision map, because their values are a possibly stale
snapshot that must never gain authority; only fresh-key copy
normalization, which founds a new video, is stamped on creation.

Keeping the revision map empty is not by itself enough, because
unstamped props resolve by the id tie-break, so a carrier arriving
with a lower id than the key-named one — absent, perhaps, or never
present — could seat its snapshot as the resolved value for a
property nothing has ever stamped. The hook therefore does not
merely decline to stamp a creation's media props: it **rewrites**
them to the video's currently resolved configuration before
admitting the record, discarding the client's snapshot entirely.
Nothing is lost, since that snapshot is only a courtesy to raw
readers, and the creation path stops being a channel through which
any value can enter. Fixtures land a delayed same-key creation
carrying superseded values, and an adversarial one where the
key-named carrier is gone and a lower-id carrier arrives with
mismatched revision-zero props; in both the resolved configuration
must be unchanged.
Client stamps order only that client's own offline view until it
reconnects; the server's order replaces them on admission, and every
client converges on the serialized result. This dissolves the
validation problem rather than solving it — forgery has nothing to
forge, since counters never come from the payload — and it makes
classification exact rather than inferred, because media edits never
ride record diffs at all: every media-prop edit is an explicit
operation in the client's durable intent store, the same queue the
sequence protocol below replays, naming the edited properties and
their values, and the hook stamps exactly those. The hook enforces that as a
rejection rule, not a convention: a raw record diff touching a media
value or its revision entry — value-only, stamp-only, or an equal
stamp carrying a different value — is rejected unless it comes from
a validated explicit operation or a named server-side repair path
(transfer, revival, normalization), so the value/stamp pair changes
as a unit or not at all, and no malformed or hostile client can slip
a new value under an existing stamp and split resolution across
carriers; adversarial tests submit exactly those three patch shapes.
A record creation —
stash replay after a force-reset included — is therefore always
carrier creation with an empty revision map, even when it is the
ghost of an edited carrier the server has since deleted: the edit
itself survives in the op queue and re-applies through owner routing
onto whatever carrier now holds authority. Nothing is lost to the
collapse and nothing stale is promoted; a test edits a carrier
offline, deletes that carrier concurrently from another client,
force-resets the editor, and lands the recreation beside a delayed
stale keyframe creation. Same-prop concurrent edits resolve by
serialization at the single authority, which is what convergence
means for a last-writer register. Both releases run the same forked
room server — the hook ships with the pre-release, so rollback
changes client behavior, never the authority.

The principal all of this keys on — stamps, epoch issuance, and
every abuse budget — is propagated, never declared. The connect
route already authenticates the user before handing the socket to
the room; it passes the resolved user id to the Durable Object as
server-generated connection context on the internal handoff, and the
room binds that identity to the socket session. Nothing
identity-shaped is ever read from the client's request — the
rotatable `sessionId` included, which is display data at most. A
test rotates arbitrary session ids under one account and verifies
they share one set of limits.

Serialization needs idempotency to stay safe under retry: a
committed write whose acknowledgement was lost, retried after
another client's edit, must not earn a fresh, winning stamp. Every
logical media write therefore carries an operation identity — a
server-issued client-instance epoch plus a sequence number the
instance increments monotonically — and the hook persists, in the
same transaction as the write, each instance's contiguous
acknowledgement watermark rather than every id. An epoch is an
unguessable **capability**, not an address: the server mints it as a
high-entropy token at issuance, binds it to the authenticated
principal, and requires it on every submission, result
acknowledgement and retirement, validating it against the persisted
binding and never against anything the client can name. Sequential
per-principal numbering orders epochs for retirement; it never
identifies them. A second *device* under the same account therefore
cannot touch this instance's epoch without stealing the token.

Same-origin sibling tabs are a different matter, and the design does
not pretend otherwise: the durable intent queue lives in origin
storage that every tab can read, so a sibling presenting the token
is indistinguishable from the owner at the server, and no
server-side check could refuse it. The hazard there is accidental
concurrency — two tabs open on one document, a duplicated tab, a
reload racing its predecessor — not a hostile sibling, since script
running on the origin has already won by other means. So siblings
are coordinated rather than isolated — and the coordination is
deliberately not a leader election. Electing one tab as the
long-lived writer would make every other tab depend on it answering,
and a backgrounded tab can stay alive while its script is suspended
or throttled: still holding the lock, no longer replying, and every
active tab blocked behind it with no crash or navigation to release
it.

Nor is it a lock of our own, nor a shared storage transaction. A Web
Lock is held until its callback settles, and an IndexedDB
transaction holds its object-store scope until its requests finish,
with no abort merely because the page froze — so any construct a
frozen tab can hold blocks every sibling behind it, which is the
leader failure again at smaller scale. The design therefore removes
the shared write path rather than guarding it: **each tab keeps its
own queue and its own epoch**, and no tab ever writes to another's.

Nothing is lost by that, because the server already treats
concurrent epochs under one principal as ordinary — it is exactly
the multi-device case — and per-epoch watermarks with retained
outcomes make draining a queue idempotent. Two tabs editing the same
property is two clients editing it, resolved by the same
serialization at the room server as any other concurrency, with no
client-side coordination to get wrong. A tab frozen anywhere in its
own append path delays only itself.

A queue outlives its tab, and the tempting way to reconcile that —
inherit the predecessor's queue and claim it — is the same trap one
level down: the claim is itself a write to the inherited queue, so a
frozen predecessor holding that scope can block the claim, and the
new tab never even reaches the fallback. There is no ownership
protocol here at all, therefore. **Every load mints a fresh queue in
its own newly created database.** A tab's write path exists before
it has looked at anything else, cannot be contended, and cannot be
blocked by any predecessor, duplicate or sibling — separate
databases are opened independently, with no shared version upgrade
to wait behind either.

An epoch is server-issued, so a queue minted offline starts
**unbound**: it accepts appends immediately, numbering them from its
own local sequence, and durability never waits on connectivity —
delaying persistence until a connection exists would be exactly the
edit-losing behavior the queue is for. What it does wait on is
identity, because a queue is namespaced by principal and an
unbound queue has no server round-trip to establish one. The
ordinary offline case supplies it locally: a user who was
authenticated before losing connectivity has a persisted session
whose principal is recoverable without the network, and that is the
namespace. Where no principal can be recovered unambiguously — a
genuinely cold start, or a session that expired — queued editing is
not silently attributed to whoever authenticates next: those edits
are held in a quarantined unattributed queue and admitted only once
the user signs in and confirms the account they belong to, or
discarded at their word. Cold-start and account-switch tests
enqueue with no principal available and assert no edit is ever
attributed to a principal that did not author it. Binding happens once, before
the first submission: the tab acquires an epoch and writes it into
the queue in one transaction, after which the local sequence
numbers are that epoch's.

Binding is **idempotent in the queue's own identity**, which is what
makes an unbound orphan safe to adopt. Every queue mints a
high-entropy id with its first local append, and the server maps
that id to exactly one epoch per principal: whoever asks to bind it
— the original tab returning, or any number of adopters racing —
receives the same epoch back. Racing adopters therefore submit the
same source operation under the same epoch and the same sequence,
where the watermark recognizes the second as the replay it is.
Without that mapping, each adopter would bind the orphan to an epoch
of its own and the same edit could be applied twice, taking a later
authoritative stamp and overwriting an intervening edit — precisely
what exactly-once is supposed to prevent. A queue is never rebound
to a different epoch; if binding is interrupted after any operation
could have been transmitted, the id resolves to the same epoch on
retry, so recovery is a repeat rather than a fork. Fixtures adopt
one unbound queue from two collectors at once, with an intervening
edit between them, and assert each operation applies exactly once —
run for both an attributed queue and one released from quarantine. A test cold-loads offline, edits, crashes,
reloads, authenticates, and asserts every offline edit reaches the
server exactly once.

Continuity across a reload is then a matter of **adoption**, not
resumption, and adoption is strictly read-only: a tab reads its
predecessor's queue — named in per-tab storage — plus any other
queue in its namespace left idle past a threshold, treats each as an
immutable log, and submits from it, recording progress in its own
database and never writing to the orphan. Because it is read-only
and idempotent, no proof of the predecessor's death is needed:
racing adopters, a duplicated tab adopting the same log as its
original, or the original itself waking up all converge, since
duplicate submissions meet the epoch watermark and are rejected as
the replays they are. And because adoption is off the critical path,
a read that does queue behind a frozen tab's transaction delays only
that recovery — new edits in the adopting tab persist and submit
regardless.

Retiring a per-load database is the one mutation adoption involves,
and it is sequenced through operations IndexedDB can actually
serialize, because "read it one last time, then delete it" is not
one of them: once the blocking connections close, a pending
`deleteDatabase` proceeds without handing the data back, and
cancelling it to reopen, read and re-request opens a gap another
producer can write into. The sound primitive is the **version-change
upgrade**, which is exclusive by definition. A collector opens the
orphan at a higher version; open connections receive `versionchange`
and close, and the upgrade transaction that follows is the only
access to that database. Inside it the collector writes a `sealed`
marker and reads whatever operations remain; a producer that later
reopens sees `sealed` and refuses to append, rotating to a fresh
queue exactly as an expired one does, so the seal outlives the
collector's connection. The operations are then written into the
destination described below, and only once that write is durable
does the collector close and delete. A blocked upgrade is simply
retried; nothing is destroyed while it waits.

Producers are fenced on their own side too, so nothing depends on
the collector reaching them: a tab checks its queue's `sealed`
marker and its lease before every enqueue, and one that finds either
— a tab suspended past the boundary and later resumed — rotates to a
fresh queue and epoch before accepting the edit. No operation is
ever appended to a queue that cannot be replayed, and none is
appended after a seal.

The destination is never shared, because a shared destination is a
shared bottleneck: a single recovery database per namespace would
put every collector's migration behind one store, and a tab
suspended mid-write there would block the others exactly as a shared
queue did. Each collector migrates into **its own queue database** —
the one it alone writes, created at its own load — so the whole
protocol touches only the collector's private store and the sealed
source it holds exclusively. No suspended tab can stand in another's
way at any step.

That is also what bounds local storage. Per-load databases are not
retained for the server's year-long replay lease — that lease
governs how long an *operation* stays replayable, not how long a
database must sit on disk — so every load folds its sealed
predecessors forward into its own database and deletes them, each
load reducing the backlog rather than adding to it. The steady state
is one database per live tab, whatever the reload, crash or
refresh-loop churn. Operations past the server's watermark retention
travel with the fold as a durable notice, so the "could not be
replayed" outcome surfaces rather than vanishing. Should a quota or
creation failure occur anyway, the tab surfaces it and refuses to
accept queued edits it cannot persist rather than accepting them
into memory it will lose.

Tests wake a tab after its lease has expired and after its queue has
been sealed; append immediately before expiry, crash before
submission, and reload only after collection has begun; suspend a
tab mid-migration while other tabs close and reload repeatedly; and
churn repeated reloads with drained and undrained queues — asserting
in each case that the edit is migrated or reported, never silently
lost, and that database count, storage use, startup time and the
availability of new enqueues all stay bounded.

Emptiness is therefore never a trigger, and a late append is not a
hazard but an ordinary case: every load re-adopts any non-empty
orphan in the namespace, so an operation appended after one
adopter's pass is found by the next, and drained-then-appended is
just a log that has grown since it was last read. Server-side
retirement still happens when an epoch goes idle, which is what
bounds the retained watermarks and outcomes; it simply is not the
thing that authorizes deletion. A failure-injection test appends
from the original after the adopter's final pass and crashes it
before submission, asserting the edit survives cleanup and reaches
the server on a later load.

Tests cover simultaneous edits from two tabs, a crash between append
and transmission, adoption of an orphaned queue by two tabs at once,
an original waking after adoption, and — the cases no lock survives
— a duplicated tab whose two sides both stay active while one
freezes mid-append, asserting the other persists and submits a new
operation without waiting on it.

Queues and epochs are namespaced by **principal and document
together**, not by document alone, because the epoch is bound to a
principal and the two keys must not drift apart. Without that, a
second user opening the same document in the same browser would
adopt the first user's queue and either wedge on an epoch the server
rightly refuses them or — worse — have those pending edits
resubmitted under their own identity. Namespaced, a principal change
is simply a change of namespace: the prior one stops being
processed, is neither discarded nor reissued, and resumes untouched
if that user signs back in, where their epoch is still theirs. Tests
cover reload during pending operations, and sign-out, sign-in and
account-switch with committed, unacknowledged and unsent operations
pending — asserting no operation is ever attributed to a principal
that did not author it. A sequence at or
below its instance's watermark is rejected as a replay, its effect
already committed; one exactly above advances the watermark.
Admission is not the only outcome that advances it: a terminal
rejection — validation, authorization, the protocol gate, the
monotonicity guard — is itself a durable per-sequence result that
advances the watermark and replays as the same failure, so one
invalid operation can never dam the queue behind it; only genuinely
retryable conditions, a lost connection or a failed transaction,
leave the watermark standing. A fixture makes sequence N terminally
invalid and N+1 valid, across reconnect and restart.

The watermark says a sequence was *decided*, never which way, so
outcomes outlive it exactly as long as they are unresolved: for each
sequence above the client's last durably acknowledged result, the
server retains whether it committed or terminally failed and why,
compacting each outcome only once the client acknowledges having
seen it. Resolution — on reconnect, or against a retired epoch —
never reads "at or below" as "committed"; it looks each decision up,
silently drops the committed ones, and surfaces the failures. The
unresolved window is bounded by the client's in-flight limit and the
replay lease, so the storage argument stands. A test loses a
terminal rejection's response before reconnect — and again across
restart, force-reset, and epoch retirement — and the failure must
surface, never pass as success.

A gap can
never form to starve the rule from the client side either, because a
sequence number exists only as the position of a durably enqueued
operation: assigning the number and persisting the operation in the
client's intent store are one local transaction, and on connect the
client replays everything above the server's watermark straight from
that queue — there is no allocation apart from the enqueue, so the
watermark always has a successor. Crash tests cut the process
between enqueue, transmission, commit, and acknowledgement.
Retirement *is* the watermark advancing, so there is no
forgotten-id window: an acknowledged operation replayed after any
amount of compaction, reconnection, force-reset (which issues a
fresh epoch), or server restart is still at or below the watermark
and still rejected, with O(1) durable state per instance. Nor does
instance turnover accumulate ambiguity: epoch ids are server-issued
and sequential per principal, and every epoch keeps exactly one
durable integer — its watermark — whether live or retired.
Retirement moves that integer into a compact per-principal retired
map and stops accepting writes under the epoch — and retirement is
not only voluntary: an epoch idle past an inactivity timeout is
retired automatically, its watermark and any unresolved outcomes
falling under the retired lifecycle exactly as if the client had
resolved and left, and each principal holds at most a hard cap of
live epochs, issuance beyond it retiring the least recently active
first. A client that submits operations and vanishes without
acknowledging therefore converges to the same bounded retired
state, and the long-duration storage test includes exactly that
abandonment. Retired watermarks live under a **replay lease** — a year by default and
host-configurable, but never freely: one ordering invariant governs
every retention knob in this design, enforced by configuration
validation that rejects violations rather than warning about them —
the replay lease is at most the exact-payload retention, which is at
most the evidence horizon, with the birth ledger tied to the
evidence horizon by construction. A still-leased operation therefore
always finds full recovery data ahead of it, never a stub or a bare
filter, and boundary tests replay exactly at each horizon's edge.
Within the lease, a client returning on a
retired epoch resolves exactly: it asks for the final watermark and
its retained outcomes, drops committed sequences, surfaces
terminally failed ones, and resubmits everything above the watermark
under a fresh epoch, safe precisely because those operations never
applied. Nothing ambiguous is ever reissued
as a fresh write, and nothing committed can apply twice. Past the
lease the watermark compacts away, and the outcome is explicit
rather than guessed: a device returning after longer than the lease
is told its pending media operations could not be replayed, and
surfaces that to the user instead of silently reapplying or
silently dropping them. The lease is what makes the bound real —
total retry state is the per-principal issuance rate limit times
the lease window, a constant, and a long-duration churn test
verifies total durable state, cold storage included, stays under
that bound rather than merely growing slowly. A
fixture commits a write, withholds its acknowledgement, lands a
competing edit, retires the epoch, and reconnects the old client:
the write must not reapply and the competing edit must stand.
Fixtures also chain a lost
acknowledgement, an intervening edit by another client, and the
retry — including replay of an acknowledged operation after
compaction — through each of reconnect, force-reset, and restart,
plus simultaneous edits in both arrival orders and a force-reset
replay of a multi-edit offline history; a stress test churns
instance creation and force-resets across restarts and asserts the
metadata stays flat.

Per-property resolution is what survives histories a single
per-carrier counter cannot. Two offline clients can go through
divergent deletions and transfers and edit different props on
different survivors, and on convergence each edit wins its own
property; nothing is discarded wholesale. Only edits to the same prop
contend, and that tie is the genuine conflict of concurrent editing —
it resolves deterministically by the stamp's total order and costs
exactly that one property, never a carrier's worth of unrelated
changes. Same-carrier concurrent-edit fixtures run both delivery
orders and a restart-with-retry. Only
three writes ever produce a nonzero revision: an edit; the delete
transfer below; and copy normalization, which stamps a new video's
owner under its own fresh key. Same-key keyframe copies are written
with an empty revision map — their media props are dead data no
reader consults — so adding a keyframe, reordering, and geometry work
can never move authority.

Authority is resolved at read time, not written back. Nothing fans
winners out across records, deliberately: read-time resolution needs
no writes at all, where a standing rewrite pass would turn every
media edit into one write per carrier, racing other clients' passes
on the same properties. tldraw sync ships record updates as per-key
patches — `diffRecord` diffs a record key by key and recurses into
`props` — so a media edit and a concurrent move of the same record
merge, and edits to different props merge wherever they land.

`videoKey` itself stays a value every carrier shares, not a
reference to the authority record: media events target the key, and
player lookup and orphan cleanup ask "does any carrier with this key
survive", never "does the authority survive".

Deletion must not lower a high-water mark. If deleting a carrier
simply removed the highest revision some prop had, a later edit could
stamp a number the deleted record still beats, and restoring that
record (locally, or by another client's undo) would win that prop's
read back with stale values. The batch delete cleanup therefore
transfers authority in the same history entry: when a deleted carrier
holds the resolving value of any prop while other carriers survive,
those values and their revisions are merged onto the smallest-id
survivor, per property, keeping the higher revision. No high-water
mark regresses; an edit after the deletion stamps strictly higher; a
restored carrier ties a transferred revision at best, carrying the
same value. Undoing the deletion needs no reversal of the transfer:
restoring the deleted carrier restores a record whose values the
transfer copied verbatim, so the tie it re-creates is between
identical values, and no revision ever moves backwards. This is a one-shot
write inside a structural delete, the same exposure as the marker
cleanup and binding repointing that already live in that batch, not a
standing reconcile pass over carrier records.

Who performs the transfer follows who owns the merged state. For an
unsynced document the deleting client's batch does, as above. In a
shared room clients do not transfer at all: a client-computed
transfer can be stale on arrival, and worse, its chosen target can
itself be deleted by a concurrent push from a client that never saw
the transfer — leaving the high stamp on two dead records while a
revision-zero survivor resolves. The room server instead repairs
authority as part of its standing per-push invariant: applying a push
gives it each deleted record's pre-image, so when a deleted carrier
held any prop's highest stamp while others survive, the server writes
those values and stamps onto a surviving carrier in the same
transaction — post-merge, the target is by construction a record that
survived. The transport-side monotonicity guard stays as defense
against any other stale write: each media prop and its stamp travel
and apply as one unit, and the server rejects an application that
would lower a prop's stamp on its record. A three-carrier fixture
deletes the authority holder and the would-be transfer target
concurrently, in both delivery orders and through restart-and-retry.

Undo never moves a revision backwards either, because a lowered
revision is indistinguishable from the stale writes the server guard
exists to reject. Undoing a media edit re-imposes the prior value as
a new edit: each affected property is written back stamped one more
than its highest revision — and only if the value being undone still
resolves, so when someone else has edited past it the undo of that
property is a no-op rather than a clobber. Integration fixtures run
media-edit undo and carrier-deletion undo through the real room
server, with and without concurrent newer edits. An edit racing a
deletion can still lose, exactly as an edit to any concurrently
deleted shape can, and no worse. The player reads the resolved
configuration regardless of which carrier is anchored.

Same-key keyframe copies still carry a raw snapshot of the current
values (at revision zero) as a cosmetic courtesy to anything reading
records raw, such as the rollback pre-release's flattened view;
correctness never depends on it. Existing documents have one carrier
per video — the original shape is the authority at revision zero.
Editing `videoId` still reloads the iframe — changing which video
this is is a different operation from moving it, and the reload is
the point.

### Existing documents

Existing videos predate the prop, so it is materialized as
`videoKey = shape.id`, which identifies each existing video as itself
— correct because today every video is exactly one shape, and
deterministic and idempotent, so it can run anywhere any number of
times. Deliberately, this is **normalization, not a schema
migration**: a tldraw migration would stamp new sequence versions
into persisted snapshots, and every release that might ever reopen
such a snapshot would then have to know those versions or refuse the
document — a regress with no safe first deployment. Instead the
persisted schema never gains a migration, only optional props, and
the materialization runs at the same authorities that already own
cleanup: the room server's standing invariant for shared documents —
applied transactionally at room initialization, before any snapshot
is served to any client, and again after every push — the
load-and-batch pass for unsynced ones, and the paste wrapper for
`TLContent` payloads. Every path a legacy record can travel ends in
one of those three, so the key is in place before any copy can be
made, and travels with every copy. A fixture opens a persisted
legacy room and copies a video from it with no client push having
occurred: the served snapshot is already normalized, and the copy
carries its key.

A read-time fallback would not be enough: a follow-up keyframe copied
from a video whose key was never stored would fall back to its _own_
new shape id, splitting one video into two identities the first time
it is animated. Materializing the key closes that hole.

## What this removes

Media events no longer need a record pointing at a shape. The binding
existed because tldraw remaps binding endpoints on copy/paste while a
shape id in props would go stale — but a `videoKey` in the frame's
action is remapped by the same operation-scoped machinery that already
handles `trackId`, so the guarantee survives without the record.

It also stops being _correct_ to bind to a shape: with several
carriers, a binding to keyframe #1 would cascade-delete a video's
events when that one keyframe is deleted.

Removed: `bindMediaControlMarker`, `copyMediaControlBinding`,
`getMediaControlBindingTargetId`, the marker parking hooks, and every
lifecycle hook on `MediaControlBindingUtil`. The util itself survives
as an inert shell, because on the client the util _is_ the schema
registration — the `bindingUtils` array is what the store's schema is
built from — and the worker keeps its explicit `createTLSchema` entry
for the same reason. Both stay so that documents already holding the
binding still validate long enough to be normalized; the Rollout section
says how.

Kept: the `media-control` marker shape. One frame per shape is still
the rule, so a media event still needs a carrier that is not the video.
`expandShapeIdsWithMediaControlMarkers` also stays, re-keyed to
`videoKey`, because copying a video should still bring its events along
and rewrite them to the copy's key.

### Delete and parking, without the binding

**Delete.** Removing a video's last carrier is deleting the video,
and its event markers go with it in the same operation. The check
runs once against the store after the whole batch, inside the same
history entry — not per shape during the batch, where deleting every
keyframe of a video in one selection would let each removal see the
others' carriers as still present and conclude nothing was orphaned.
Living inside the history entry also means one undo restores markers
and carriers together. Deleting one keyframe of an animated video
leaves the events alone — which the binding's per-shape cascade would
have got wrong.

This is an explicit deletion semantic, not garbage collection from
whatever a client happens to see: markers are removed only as part of
the operation that deletes their video's last carrier. On a shared
room, though, "last" is a claim the deleting client cannot settle —
another client may be extending the video at that moment, and
honoring the marker removals then would strip a surviving video of
its events, a loss no sweep can reconstruct.

So the claim is explicit, and the room's server — which already runs
the custom schema and owns the merged state — arbitrates it. Record
operations carry no intent, and co-occurrence cannot supply it: a
user may delete an event and a keyframe of the same video in one
legitimate batch. The cascade therefore announces itself — the
deleting client sends the room, alongside its push, the video keys it
claims fully deleted — and, per key, the exact marker ids its cascade
removed. Intent is per marker, not per key, because one batch can mix
both kinds: a user may explicitly delete an event in the same
operation that removes the video's last carrier. A claim is
validated against server-side pre-images before it is honored, and
the validation separates forgery from staleness.

First, a claim must be about something that actually happened: the
claimed key must have a carrier pre-image deleted by this very push,
and the merged state must have lost its last carrier *because of*
that deletion. Without this, a claim would be a free instruction to
mint durable evidence — an authenticated editor could submit empty
claims for keys that never existed, and each one, trivially having
no surviving carrier, would leave a tombstone: recovery storage
consumed with no carrier creation and no birth-ledger entry behind
it, and a key poisoned against whoever legitimately mints it later.
Claims naming a key this push did not empty are rejected outright,
empty ones included. Second, a claimed marker
whose pre-image targets a *different* key, or whose removal does not
arrive in the same push, is forgery: it rejects the whole claim, so
no client can launder another video's events into a tombstone under
an unused key. A claimed marker that simply no longer exists is
staleness, not forgery — another client legitimately deleted that
event first — and it is dropped from the claim while the rest is
honored. Voiding the claim there would be the worse outcome by far:
the carrier deletion would still apply, leaving no carriers, no
markers, and no tombstone to recover from. The tombstone is
therefore always created when a claim's key loses its last carrier,
carrying the configuration even when every claimed marker turned out
to be already gone. Adversarial fixtures claim a nonexistent key and
claim markers belonging to another video; a race fixture has one
client explicitly delete a marker and another land a stale
last-carrier cascade naming it, asserting the tombstone exists with
its configuration intact; adversarial fixtures also submit an empty
claim and a claim for a key this push did not empty, asserting no
tombstone and no retained evidence result. Only the claimed
marker ids are arbitrated; every other marker removal, an explicit
event deletion batched with anything at all — including a cascade of
its own video — applies as pushed whether or not the claim survives.
Fixtures prove an explicit deletion sticks when co-batched with a
non-last carrier deletion, and when co-batched with a raced
last-carrier cascade, under both delivery orders.

Arbitration is the server's alone. If the merged state still holds a
carrier of a claimed key — a concurrent extension arrived first — the
claim is refused: the claimed marker removals are declined and those
markers rebroadcast, while the same push's explicit removals stand. If none survives, the removals apply, and the claim
leaves a **durable tombstone**: the removed marker records, together
with the video's resolved media configuration and its per-prop stamps
at the moment of deletion — deleting the last carrier deletes the
records that held authority, and without this a late revival would
resolve configuration from whatever stale snapshot the arriving
carrier happens to hold — persisted in the room's storage next to the
document itself, never held only in connection memory — and persisted transactionally with the data it
protects. The room ordinarily applies changes in memory and snapshots
lazily; a claim-bearing push opts out of that path: the server
persists the updated snapshot and the tombstone in one synchronous
SQLite transaction before acknowledging or broadcasting the push.
Claims are rare — a video deletion — so the eager write costs nothing
measurable. If the transaction fails, neither side commits and the
claim is re-arbitrated when the push retries; fault-injection tests
kill the process at each storage boundary and reconstruct the room.

None of this exists as extension points in stock `@tldraw/sync-core`
3.15.5: `TLSocketRoom` applies pushes and acknowledges internally,
its receive callback is observational, and `onDataChange` fires after
the commit — too late to reject a stamp regression, transform a
claimed push, or hold the acknowledgement for a storage transaction.
The server-side protocol therefore stands on a small maintained fork
(or vendored subclass) of `TLSyncRoom` that exposes a pre-apply hook:
validate and transform the incoming diff, commit room state and
tombstones in one SQLite transaction, then acknowledge and broadcast.
Proving that hook — a prototype carrying the fault-injection tests
above against the real boundary — is the first implementation
milestone, gating every behavior that depends on it; if upstream
grows an equivalent hook, the fork retires into it. Retention cannot be tied to who is connected or
what they have acknowledged, because tlsync force-resets a client
whose baseline predates its pruned history and then reapplies and
pushes that client's stashed changes on top of the fresh state — an
arbitrarily old offline extension can arrive at any later time. So
retention is long but bounded — "video deletions are rare" is not an
invariant a scripted or hostile editor honors, and unbounded
tombstones would let repeated create-and-delete cycles exhaust the
room's storage while the visible document stays small. Each room
keeps full tombstones for a retention window — 30 days by default,
host-configurable — and the window is a guarantee, not a hope:
quota pressure inside it never destroys a payload. When in-room
bytes run short, full tombstone payloads spill to the same cold
storage the stubs use, restorable from there exactly as from the
room — and through the same idempotent spill state machine the stubs
use: the local payload stays authoritative until the cold object is
durably confirmed, a resumable spill intent and the cold-object
reference persist in the room's own storage, and only then is the
local payload retired, so a crash at any boundary duplicates work
but never strands a committed deletion without its recovery data.
Fault-injection covers constrained-room spills of restorable
payloads, not only metadata stubs, cutting the process between cold
upload, storage commit, acknowledgement, local cleanup, restart, and
revival. The in-room byte accounting is per authenticated
principal, so one editor's churn spends that editor's budget and
can never evict another video's recovery window. And the window is
in-room residency, not the payload's life: past it, the payload
stays in cold storage for the entire exact-stub tier — years, and
deliberately longer than the replay lease that bounds the longest
supported offline absence — so a revival at any point in that tier
still restores completely and atomically. Count and bytes surface
as room observability; a stress test proves storage and restart
cost stay bounded under create/delete cycles, and fixtures revive a
video inside the 30-day window after sustained adversarial churn,
and again deep in the stub tier, and must restore it in full both
times. Stubs are never evicted inside the
evidence horizon defined below — they are the last evidence a
deletion happened — but they need not
live in the room to do their job. When in-room stubs exceed a size
threshold, the room automatically spills the oldest ones' exact keys
to cold storage outside it — the worker platform has cheap durable
stores for exactly this — where capacity is effectively unbounded.
The spill is a small idempotent state machine, because it touches
three stores that cannot commit together: the exact keys are written
to cold storage and confirmed first, then the in-room filter is
republished — a pure, replayable function of the cold set — and only
then is the local stub deleted, with a durable spill-intent record
letting a restart resume an incomplete spill from the last confirmed
step. At every point of every interleaving a key lives in the local
stubs or the confirmed cold set, so a crash can duplicate work but
never open a false-negative window; fault-injection tests kill the
process at each cross-store boundary and then revive a spilled key.
No terminal "deletions refused" state exists anywhere in the
lifecycle: no volume of authenticated churn can take a core editing
operation away from legitimate users, and the per-principal rate
limit on deletion claims is a throttle against abuse, never a dam
that fills. Storage degradation gets an explicit contract instead of
an impossible promise, though: the room reserves local headroom for
recovery payloads ahead of the document's own growth, and that
reserve is partitioned into per-principal shares — isolation
enforced at admission, not implied by accounting. A principal whose
churn fills its own share has its deletions deferred as retryable,
with backpressure surfacing before exhaustion, while every other
principal's share, and therefore their deletions, remains untouched;
only when a principal's share is exhausted *and* cold storage is
unavailable — the one state in which that principal's recovery data
cannot be durably persisted anywhere — does its deferral engage at
all. Deferred, not refused: policy never takes deletion away, and
the retry lands the moment either store recovers.

Shares are allocated, not assumed, because a finite reserve cannot
promise every principal a share without bounding how many there are.
A share is held only by a principal with unspilled recovery
payloads — the ordinary state is spilled and holding nothing — and
is sized as the reserve divided by the admitted count, floored at a
minimum viable share; the reserve therefore admits a bounded number
of concurrent holders. Allocation is first-come: an existing
holder's share is never shrunk below the floor to make room, so
isolation means what it says, and a principal arriving when the
reserve is fully allotted has *its own* deletions deferred as
retryable — the same deferral, reached one step earlier, never a
tax on anyone already holding. Shares are released as payloads
spill or expire, so the bound is transient by construction: it can
only be reached while cold storage is down, and it dissolves when
cold storage returns. Tests churn one principal to its share limit
under cold-storage failure and prove another still deletes, and
introduce principals until the reserve is fully allotted, proving
the newcomer defers while existing holders are unaffected and that
all of them recover when cold storage does. What the room never does is accept a
deletion it could not back with recovery data, or shed evidence to
make one fit. A test fills the room to its actual quota with cold
storage down, proves the deletion defers with the documented error,
then restores cold storage and proves the retry succeeds. In the room, a compact membership filter summarizes the
spilled keys as a fast negative check — keys are shape ids with no
order, so membership is the only possible test — and it is only
that: a filter positive is confirmed against the exact cold-storage
set before anything is flagged, so a freshly minted video can never
draw a false revived-without-events warning. A filter false positive
costs one cold read, never a wrong flag; the filter's error rate is
a performance knob, not a correctness bound. An *unconfirmable*
positive — the cold read failing or timing out — gets the same
contract as an unreadable tombstone: the push commits nothing and
returns retryable, because failing open could admit a stale revival
and failing closed forever would block a fresh video over a false
positive, so the design does neither and waits, visibly. Outage and
timeout fixtures cover both a true and a false filter positive. Inside the evidence
horizon, detection never falls silent, and in every exact tier it
never cries wolf; the one tier that can over-warn is named below,
and its warnings say so.

Every path that mints a tombstone or stub debits the same budget.
The standing sweep attributes its work to the authenticated
principal whose push emptied the key, so omitting claim metadata and
letting the sweep clean up is not a way around the deletion
throttle — and that attribution is durable, not inferred at sweep
time: the principal is persisted with the pending state in the same
transaction that applies the emptying push, so a crash-persisted
partial batch still knows whom to charge at the next load. What
genuinely has no principal — a rollback-window deletion recorded by
a release that kept no provenance, a legacy orphan — draws on a
small, bounded room-owned recovery reserve, separate from every
principal share precisely so it cannot be farmed: it serves only
unattributable orphans, and if momentarily exhausted the sweep
defers as retryable, the orphan markers persisting harmlessly until
it succeeds. A restart test loads a room holding an unattributable
orphan with every principal share exhausted and no client connected,
proving the sweep draws the room reserve — or defers and later
completes — without touching any principal's share. Meanwhile, and a room-wide creation rate cap bounds how fast durable
evidence can be forced into existence by any mix of principals. The
exact-key set ages through a tiered lifecycle rather than toward a
terminal cap: full tombstones (in-room, restorable) become exact key
stubs (cold, still restorable — the payload travels with them), and
only after a host-configurable retention measured in years do stubs
and payloads compact into the filter tier. A revival there is
**quarantined**, not silently committed: the carrier is admitted
into an explicitly quarantined state the editor must resolve — keep
it as a new video or discard it — never presented as a healthy video
that quietly lost its history, and the accompanying warning is
marked unconfirmed — the filter tier is the one tier that can
over-warn, and the design accepts that explicitly rather than
claiming otherwise: the warning is phrased as a question about very
old content, not an assertion of loss, and it is dismissible, with
the dismissal recording the key in a small confirmed-fresh set so
the same false positive never returns. A dismissal silences one
false positive, never future evidence: it is scoped to the state
that produced it, and the tombstone-minting path clears any
dismissal for a key in the same transaction that records the key's
real deletion — so a video that collided with the filter, was
declared fresh, and is later genuinely deleted warns again exactly
as an undismissed key would. A fixture chains filter collision,
dismissal, real deletion of that key, compaction into the filter
tier, and late revival, and must see the warning return.

The lifecycle ends at an explicit **evidence horizon** —
host-configurable, five years by default — rather than pretending to
infinity. Filters are generational, each covering a cohort of keys
by deletion age and exact-sized for that cohort at build time; a
cohort crossing the horizon is dropped, filter and dismissal records
with it. Inside the horizon every bound holds because every
structure is sized from exact data; past it, the design says plainly
that deletion evidence is gone — the one honest alternative to a
filter that saturates toward flagging everything or a store that
only grows. Gone evidence does not mean an open door, because key
provenance outlives key evidence. The room keeps a **birth ledger**
— one tiny entry per `videoKey` ever created, the key and its birth
stamp, written when the serialized creation first lands — spillable
to cold storage and content-proportional rather than
churn-proportional, debited to the creating principal like every
other budget. A genuinely new video is born in the push that first
names its key and matches its ledger entry exactly; a carrier
creation whose key has a ledger birth older than its own push, no
live carriers, and no remaining evidence is by definition a revival
of something whose evidence expired — an active session's
years-late undo included, which no baseline check could catch — and
it is quarantined for explicit resolution, never admitted as a
healthy new video. Sessions whose reconnect baseline predates the
horizon are additionally quarantined wholesale.

The ledger itself is finite, because every legitimate producer of an
old key is finite: offline replay is bounded by the replay lease,
pre-horizon reconnect baselines are quarantined wholesale, and the
local undo stack expires structural video entries at the evidence
horizon — a session-local, in-memory stack never approaches that age
in practice, and the bound is enforced regardless, surfacing an
expired undo as a no-op with a notice. A ledger entry whose key has
no live carrier therefore expires with the horizon too: past it no
legitimate path can resurrect the key, and a fabricated client that
mints an "old" key is indistinguishable from a client authoring a
new video — a power every authenticated editor already has, gated by
the same creation budgets. What remains is content-proportional in
the true sense — entries for live keys plus one horizon window of
churn — and the long-horizon stress test asserts total birth-ledger
and cold-storage size against exactly that bound. Fixtures cover the
reconnect replay, an active-session undo performed after the horizon
(the expired no-op with its notice), and an operation rebased from
retained local history. Cost decays with age, no tier ever refuses a legitimate
deletion, and a long-horizon test drives churn across generations,
asserting false-positive and cold-lookup rates hold their configured
targets. A stress test drives create/delete churn
through the spill path — claimless carrier deletions swept
server-side included, and through rotated connections — and pins
in-room storage, restart cost, cold-lookup rate, and the budget;
fixtures create fresh keys that collide with the filter and revive a
spilled key. Within the full-tombstone window, restoration is
unconditional: whenever a tombstoned key gains a carrier again, the
server restores its markers, writes the tombstoned configuration and
stamps onto the arriving carrier under the usual monotonic rules — so
a stale offline snapshot cannot demote the video's configuration —
rebroadcasts the result, and clears the tombstone. Unconditional
means unconditional-or-unadmitted, never best-effort: revival is one
atomic, retryable operation, so when the payload lives in cold
storage and the read fails or times out, the carrier push commits
nothing, acknowledges nothing, and returns retryable with the
tombstone untouched — the server never admits a carrier it cannot
restore behind, which is exactly what would let stale configuration
or missing events leak. Fixtures cover cold-store outage, timeout,
restart mid-revival, and a concurrent edit racing a retried revival.
A further fixture edits
the configuration after an offline carrier was created and before the
visible last carrier is deleted, then revives, and must see the
edited configuration. That is semantically right, not just race repair — fresh
videos mint fresh keys and paste remints them, so a key only ever
returns as a continuation of the deleted video.

Restoration is marker-aware, never bulk resurrection over intent. An
explicit marker removal prunes that marker from its key's tombstone
as well as from the store — so an event deleted by an offline client
stays deleted when the same push revives its video — and a marker the
push itself supplies, an offline edit, is never overwritten by the
tombstone's stale copy: restore puts only markers absent from both
the merged state and the arriving push. Within one push, pruning runs
before restoration; across pushes, the same end state falls out of
ordinary explicit-deletion semantics, since a restored marker deleted
afterwards is just an event deletion.

Explicit-deletion intent must also survive tlsync's force-reset,
which re-bases a long-offline client by discarding its baseline and
reapplying its stashed changes onto fresh server state — where a
stashed marker removal becomes a no-op, the marker being absent from
the snapshot already, and would never reach the server as a record
operation at all. So the intent does not ride the record stash: the
client records each explicit event deletion — marker id and key — in
its own durable state and reports them as prune requests on every
connect until the server acknowledges them. That store is ordered and
reversible, not append-only: undoing the deletion — or any local
restoration of the marker — cancels the pending prune, so what a
client reports on connect is the net of its history, and a
delete-then-undo reports nothing. Pruning is idempotent, and a prune
naming a marker no tombstone holds is a no-op.

That store and the editor's own persistence are two durable surfaces
with no shared transaction, so their ordering is specified rather
than assumed: the intent store is written **first** and is the
source of truth, the editor mutation is the derived step, and each
intent carries a phase — `intended`, then `applied` once the local
record and its history entry exist, then retired on acknowledgement.
Recovery therefore always converges forward: an intent found in
`intended` after a crash is re-applied to the editor, which is safe
because applying a deletion to an already-deleted marker is a no-op
and the history entry is rebuilt with it. The reverse hazard — a
committed editor deletion with no intent — cannot arise, because the
intent precedes it. Undo after acknowledgement is likewise defined:
the marker is restored as an ordinary creation and the prune is
cancelled if still pending, or countered by that creation if not,
which is exactly the durable-tombstone restore path. Crash tests cut
the process at each boundary — intent persisted, record and history
mutated, transmitted, acknowledged — and assert the editor and the
intent store agree afterwards. The reset-path fixture
drives the real reset and stash-reapply flow, not a hand-built final
push, and one chain covers the full hazard: offline event delete,
local undo, concurrent video tombstoning by another client,
reconnect, then carrier revival — the event must come back.

Both delivery orders, a reconnect after offline editing, and a
reconnect so late the client was force-reset all converge on a video
that is entirely gone or entirely intact, with no client-side repair
rule to race. Fixtures run the race in both message orders, through a
reconnect, and through a server restart that reloads tombstones from
storage before the offline client returns — including variants where
the offline client also deleted or edited one of the tombstoned
events, which must stay deleted or keep the edit. Undo on the deleting
client stays whole too: its history entry holds carriers and markers
together, and re-putting an already-restored marker is a no-op, so
the tombstone never fights an undo. Markers left behind for a key
with no carriers and no claim on record — however record operations
were split or ordered — fall to the standing sweep below.

Orphans that no operation removed — a crash mid-batch, or a deletion
performed under the rollback pre-release (see Rollout), which
preserves new-vocabulary markers but does not understand their
targets — are collected by the same standing invariant: on the sync
server after every applied push, and locally, at load and after each
batch, for unsynced documents. A client of a shared room never sweeps
from its own, possibly partial, view. Nor is the sweep a second,
weaker deletion path: its removals commit through the same
transactional, marker-aware tombstone as an accepted cascade claim,
so a carrier arriving late — an offline extension, a force-reset
replay, a rollback-window edit surfacing after roll-forward —
restores swept events exactly as it restores cascade-deleted ones.
One honest asymmetry is stated rather than papered over: a cascade's
tombstone carries the resolved configuration because the server
holds the deleting push's pre-image, but a sweep can meet an
already-persisted carrierless orphan — a crash-persisted partial
batch, a rollback-window deletion — where no pre-image exists
anywhere. The sweep then writes a markers-only tombstone flagged
configuration-incomplete, and a revival restoring from one restores
the events atomically while **quarantining the configuration side**:
the arriving carrier's own settings are surfaced for explicit
confirmation instead of being silently trusted as the video's
configuration. Temporary absence is never proof of permanent
deletion, and fixtures land a late carrier after a sweep across
delivery orders, a force-reset, and a server restart — including a
restart that sweeps a persisted carrierless orphan before the stale
carrier arrives, asserting events restore and configuration
quarantines.

**Parking.** Markers are invisible and zero-size, but they still count
toward `getCurrentPageBounds`, so a marker left behind by a moved video
skews `zoomToFit`. Parking therefore follows the carrier's _page_
position: a reaction on the carrier's `getShapePageTransform` — not a
store side effect on the carrier record — keeps a video's markers at
its position, so movement that never touches the carrier itself
(dragging a parent group, resizing an enclosing frame, reparenting)
parks just as well as dragging the video does. With several carriers
per video, parking has one authority, not one reaction per carrier
racing writes to the same markers: each client runs a single
reaction per `videoKey`, parking the video's markers at the
earliest-keyframe carrier's page transform — the player's *default*
anchor rule, deliberately without the local double-click override
that can re-anchor the player during editing, because parking must
be a pure function of the converged document while interaction is
per-client — re-evaluating in the same batch when that carrier is
deleted or reordered, so markers never linger at a stale anchor's
coordinates. Concurrent clients therefore compute identical
positions and their writes converge idempotently even while each is
editing a different carrier; a multi-client test does exactly that
and asserts identical marker positions and bounded write counts. The cheaper alternative
— park once at
creation and accept drift — is rejected: the drift is unbounded in the
one case users notice, which is moving a video far across the canvas.

## Editing

Video shapes render a static poster
(`i.ytimg.com/vi/<id>/hqdefault.jpg`), and the runtime anchors the one
live player to a single carrier of each `videoKey` — so a video is
still playable and interactive while editing, and the other keyframes
show where it will travel to. Nothing about a shape mounts a player, so
copies cost nothing.

Interactive does not mean pointer-stealing. Input belongs to exactly
one of the player and its anchored carrier at a time, the other
being `pointer-events: none` (see "Where the player lives"): while
idle the carrier holds it, so selecting, dragging and resizing stay
ordinary canvas gestures; double-clicking the video enters the
shape's editing state — the same convention tldraw's own embed
shapes use — which hands input to the player until editing ends with
a click elsewhere or Escape. In presentation mode the default flips:
canvas editing is off, and the player holds input whenever the
video's `controls` allow it.

Authoring a movement keyframe is then the same gesture as for any other
shape: extend the sequence from the timeline's follow-up-frame button,
then move or resize the new copy. No ghost outline, no bespoke
transform editor, no second kind of marker — the reason those were on
the table was that copies were forbidden.

`canExtendFrameSequenceFrom` drops its carrier-type exclusion for
videos; it keeps the action-type exclusion, since media events are
still added with "+ Media event" and chained by dragging.

## Alternatives considered

**Keyframe target on the marker's transform.** Markers carrying a
`shapeAnimation` frame become visible as a draggable ghost of the
video, and their transform is the target. Good authoring ergonomics
without touching the player architecture, but it needs the `w`/`h`
props back, makes parking and visibility conditional on the frame's
action type, and keeps every video a live player — so the remount
hazard and the withheld buttons stay. It buys movement without
simplifying anything.

**Keyframe target in the action's metadata.** Markers stay uniformly
invisible and no props change, but nothing on canvas represents the
target, so it needs a purpose-built overlay with its own drag and
resize handles: the most new UI of the three, reimplementing what
tldraw already gives a copy.

Both were shaped by the constraint that a copy of a video is
impossible. Removing that constraint is what makes them unnecessary.

**Mounting the player on one carrier shape.** Keeps live editing
without an overlay, by designating a single carrier as the host. Two
things break it. Culling is computed from a shape's own store bounds
and sets `display: none` on its container, so a player visually
displaced onto the screen is hidden whenever its host's home position
leaves the viewport. And re-anchoring — at a step boundary, when the
host is hidden by the visibility rule, or when it is deleted — moves
the iframe between DOM parents, which reloads it. Runtime ownership
avoids both while giving the same live editing.

**Multiple frames per shape.** Would remove the marker entirely, but
one-frame-per-shape is load-bearing across the derivation, the timeline
UI and reconciliation. Rejected for the same reason the media-event
array was rejected earlier: it trades one record type for a rewrite of
everything that reads frames.

## Rollout

The persisted vocabulary changes: the `mediaControl` action gains its
target key, `youtube-embed` gains `videoKey`, and the `media-control`
binding stops being written. `SYNC_CLIENT_VERSION` moves three times
— the acceptance stage described below takes 4, the rollback
pre-release 5, the main release 6, leaving 3 to the release
currently deployed — and the gate becomes two-sided: a server
refuses clients newer than itself as well as older. Every stage
takes its own number, the acceptance stage included, precisely
because it is not behaviorally the current release: it carries the
widened validators and the compatibility behavior a
future-vocabulary room needs, and letting it share version 3 would
make a dormant pre-stage tab indistinguishable from it — free to
connect, after a rollback, to a room it would reject the vocabulary
of. Numbered separately, that tab is refused and reloads. A rollback
test parks a version-3 tab through stage B's promotion and
reconnects it only after the rollback to stage A. One number per
release keeps each client's vocabulary matched to the assets that
serve it; the server side needs no such split, because every release
in the sequence ships the same forked room server — arbitration,
tombstones, stamps and all, gated by the document's vocabulary as
stage A describes. What must survive the forced reload is
client-side intent: an unacknowledged cascade claim is durable state
in the same ordered intent store as explicit-deletion prunes, keyed
to the document, and the pre-release client replays or cancels
pending entries on connect exactly as the main client would. A
last-carrier deletion made just before a rollback reload therefore
keeps its claim, and a concurrent extension still wins add-wins
arbitration instead of meeting bare, claimless removals; an
end-to-end fixture deletes a last carrier, withholds the
acknowledgement, forces the version-6-to-version-5 reload while
another client adds a carrier, and verifies every marker survives.
Refusal alone swaps no JavaScript, so the client
defines the transition: on the incompatible-version response it stops
reconnecting, forces an asset reload that bypasses caches, and — if
the fetched bundle still reports the refused version, as it briefly
can while a rollback propagates — backs off behind a visible
"deployment changed, reloading" notice rather than spinning. An
end-to-end test starts a version-6 browser client, rolls the
deployment back, and proves the session resumes as version 5.

Documents that already hold the binding are normalized on load, not
stranded. The version gate only refuses *clients*; it does nothing
for the binding records that existing documents contain, and those
documents surface in more places than the sole-user framing suggests —
synced rooms, snapshot files, clipboard payloads, locally cached
copies. Every path lands at one of the three normalization
authorities (see "Existing documents"), which apply the same
idempotent rewrite:

- The binding type stays registered (see above), so the old records
  load instead of failing validation.
- `videoKey` is materialized as `shape.id` on every legacy video,
  and its birth-ledger entry is backfilled in the same transaction —
  a synthetic birth stamp at the normalization's own serialization
  point, debited to the room rather than to any principal — so
  late-revival detection covers legacy videos whose evidence later
  expires. A fixture normalizes a legacy room, deletes such a video,
  ages its evidence past the horizon, and proves a stale revival
  still quarantines.
- Each `media-control` binding is resolved: the video shape at its
  `toId` supplies the target key written into the `mediaControl`
  action carried by the marker at its `fromId`. The event keeps its
  target. The binding record itself stays, per the rollback rule
  below.
- Legacy stores can also hold degraded records — a marker that lost
  its binding, a binding whose endpoint is missing or of the wrong
  type — and today the mount path deletes unbound markers as its
  recovery. That recovery moves into the same pass: a marker whose
  `mediaControl` action cannot be given a target — no binding, or a
  binding that does not resolve to a video — is deleted, along with
  any dangling binding. Deleting these is rollback-neutral, because
  the previous release's own cleanup does the same.
- The pass reads only what is in the store, so it is deterministic
  and idempotent: running it again, anywhere, changes nothing.
- A pasted `TLContent` payload goes through the paste wrapper —
  which already does operation-scoped preprocessing for frame
  remapping — before identity remapping runs. Pasted output is new
  content, so it is written in the new vocabulary, without bindings.

Retained bindings alone cannot make rollback safe, because the
materialized `videoKey` prop is itself a poison pill to the release
currently deployed: its `youtube-embed` schema does not declare the
property, and tldraw validation rejects unknown props, so a normalized
document would fail to load before any binding is consulted. (The
action's target key has no such problem — frames live in `shape.meta`,
which tldraw does not validate, so older code just ignores the extra
key.) Rollback therefore gets explicit floors, and each floor is
itself deployable with a floor beneath it:

- **Stage A, acceptance.** Identical to the current release except
  that its validators accept the future optional props and it
  carries the two-sided version gate the later stages rely on. It
  writes nothing new, changes no behavior, and — like every release
  in this sequence — adds no schema migrations: none exist, because
  materialization is normalization, so no snapshot is ever stranded
  behind unknown migration versions. The forked room server ships
  here too, gated by the **document**, not by the protocol version
  it serves: a room whose document bears no future vocabulary gets
  none of the new machinery — no normalization, no stamping, nothing
  written, which is the byte-identical guarantee — while a room
  whose document already bears it, which only a later stage can have
  produced, runs the complete authoritative pre-apply path — stamps,
  arbitration, tombstones and all — whatever client protocol is
  connected. The stage boundary gates which clients connect; the
  document gates what the server does; and crossing from legacy to
  future vocabulary is never a client's act at all, which is what
  keeps the gate from becoming a bootstrap deadlock. Under stage A a
  pure-legacy document is inert: every future field or record shape
  in a push is stripped or rejected whatever the client says — the
  declared version is an unauthenticated claim, and a doctored
  connection cannot smuggle `videoKey` into a document that would
  then strand on rollback. From stage B onward the server itself
  **promotes** a legacy room at initialization: atomic, trusted
  normalization plus an explicit persisted vocabulary marker, after
  which the room is future-vocabulary and the full path serves it —
  an integration test starts with a legacy shared room, lets stage B
  promote it and accept its first new-vocabulary write, then rolls
  back to stage A and proves the full path still serves it. A stage-B-to-A
  integration test proves the rolled-back server issues
  authoritative stamps and preserves cascade and tombstone semantics
  on a future-vocabulary room, not merely that the client routes an
  edit. That makes rolling stage A back to the current
  release trivially safe; a round-trip test opens, persists, and
  rolls a shared room back against the actual current release —
  including a connection that deliberately submits future vocabulary
  — before anything later ships. Stage A's write behavior is
  document-sensitive, which is what makes both of its neighbors
  safe: a document containing no future vocabulary gets exactly the
  current release's behavior and stays byte-identical — the
  A-to-current guarantee above — while a document already bearing
  future vocabulary, which only a later stage can have produced (so
  rolling it back past A is already out of the window), gets the
  write-compatibility shims: media edits routed and stamped as
  operations, duplicate and paste minting fresh keys. An ordinary
  edit under a B-to-A rollback therefore cannot park a new value
  under an old stamp, and a duplicate cannot rejoin its source;
  fixtures edit and duplicate under rolled-back stage A on both
  document kinds.
- **Stage B, the pre-release.** The main release's rollback floor,
  described next. Rolling it back means rolling back to stage A,
  whose validators accept everything stage B writes.
- **The main release.** Rolling back means rolling back to stage B.
  Rolling back past a stage leaves the support window once the next
  stage has shipped.

The pre-release's contract is that every ordinary edit made under it
leaves main-release documents consistent, which means it understands
the new vocabulary without shipping any new feature:

- It inherits stage A's widened validators and adds no migrations,
  so snapshot version stamps never diverge between releases and a
  room persisted by any of them loads under any other. The
  `TLSocketRoom` round-trip fixture — build and persist a room under
  the main release, reopen it under the pre-release — proves the
  whole load path, not merely record validation.
- Its duplicate and paste paths run the main release's identity
  remap — shared code, not a reimplementation: a copied video gets a
  fresh `videoKey` by the same rule the main release uses,
  target-keyed markers travel with the copy the way bound markers do,
  and their actions are rewritten to the fresh key. A rollback-window
  duplicate therefore stays an independent video on roll-forward
  instead of rejoining the original.
- Its media-prop editing is authority-routed and revision-stamped,
  exactly as the main release stamps its own edits, so a
  rollback-window edit holds authority on roll-forward instead of
  sitting unread on a non-owner record.
- Its binding delete cascade is `videoKey`-aware: a bound video
  deleted while another carrier of its key survives repoints the
  binding at the survivor instead of cascading into the marker — a
  state only main-release edits can produce, so purely legacy
  documents behave as before. The same delete path performs the
  authority transfer, so revision high-water marks survive
  rollback-window deletions too.
- Its mount-path cleanup narrows to true legacy orphans — markers
  with neither binding nor target key — so new-vocabulary markers
  pass through untouched.
- Its playback path falls back to the action's target key when a
  marker has no binding — one lookup, not a feature — so media events
  authored by the main release keep executing during rollback instead
  of loading as inert records. An end-to-end fixture presents a deck
  under the rolled-back release and asserts the commands run, not
  merely that the records survive.
- Its `youtube-embed` render is key-aware for the same reason: among
  carriers sharing a `videoKey` — a state only main-release documents
  contain — exactly one, the carrier the target-key lookup selects,
  mounts a live iframe, and the rest render posters. Without this, a
  rolled-back deck holding movement keyframes would mount one player
  per keyframe, resurrecting the duplicate-player hazard this design
  exists to remove, with commands landing on a different carrier than
  the one on screen. Rollback tests assert the iframe count, the
  visible carrier, and the interaction target.

Media events the pre-release authors are dual-written: the legacy
binding its own behavior needs, and the action's target key
alongside. The main release's normalization would derive the key
from the binding anyway; writing it eagerly means the event is
complete from the moment it exists, with no window where only the
binding carries the truth. A fixture creates an event under the
pre-release and proves it still targets and controls its video after
roll-forward. The main release follows once the pre-release is
deployed.

Well-formed bindings are rewritten but not deleted. Deleting them
would make an ordinary deployment rollback destructive: the previous
release resolves events through bindings and deletes an unbound marker
as an orphan, so a document opened once by the new release and then
reopened by the old one would silently lose its media events. Left in
place — inert to the new code, intact to the old — they keep
everything the old release wrote survivable under rollback.

Surviving the first open is not enough; the guarantee has to survive
edits — and at the merged state, not in any one client's view, since
a client-chosen replacement can itself be concurrently deleted,
stranding the binding on a dead target while a third carrier lives.
Binding repair is therefore part of the room server's standing
post-merge invariant, exactly like authority transfer: after each
applied push, any retained binding whose target is absent is
repointed to a surviving carrier of its `videoKey` before the result
is broadcast, and deleted only when no carrier survives. The
rollback release then always finds bindings pointing at live shapes,
whatever interleaving of deletions produced the merge; only when the
last carrier goes do events, markers and bindings go together. Tests
delete the bound carrier and its chosen replacement concurrently, in
both delivery orders, through restart and through rollback. Unsynced
documents get the same repair from the local batch cleanup, in the
same history entry.

Content
authored by the new release (movement keyframes, new media events,
pasted copies) is written without bindings. Under the pre-release its
media events still execute, through the target-key playback fallback
above; what stays dormant is the movement itself: the pre-release
mounts no runtime player and never tweens, rendering the selected
carrier as the one live embed and every other keyframe as a poster.
Everything validates, survives the narrowed cleanup untouched, and
works fully again on roll-forward.

Media-prop edits made during the rollback window survive roll-forward
by construction: they are routed and revision-stamped the same way
the main release's own edits are, so they are the authoritative
values every reader resolves after roll-forward. A fixture edits a media prop
through a non-owner carrier under the pre-release and proves it holds
authority after roll-forward.

Fixtures pin all of this. A document captured from the pre-normalization
schema, holding a video with `media-control` bindings, must load under
the new schema with its event targeting intact — and, reopened under
the previous release's schema and cleanup rules, must still have its
events, including after the round trip that adds a keyframe and
deletes the originally bound carrier. Another round trip covers the
other direction: an event authored under the main release, opened
under the pre-release, then reopened under the main release, survives
both hops — including the variant where the bound carrier is deleted
while the pre-release is the one running, and the variant where the
_last_ carrier is deleted there, whose now-targetless markers the
load sweep collects on roll-forward. Duplicating and pasting a video
under the pre-release round-trips too: the copy returns to the main
release as an independent identity with its events attached. Sibling fixtures hold the degraded states — an unbound marker,
a binding with a missing or mistyped endpoint — and must come out with
those records gone. A pre-change `TLContent` fixture pasted through
the wrapper must come out with its event targeting the pasted video.

A later release deletes the inert binding records once rolling back to
binding-reading code stops being supported; the schema registration
and the inert util go with them. That cleanup is the whole remaining
compatibility surface, and it is a later judgment call, not a step in
this rollout.
