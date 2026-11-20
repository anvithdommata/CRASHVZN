# Pass 2: measure the crash precisely

An earlier pass over the whole footage found this (same plan frame, ids and origin; keep them):

```json
{{pass1}}
```

The incident scan reported:

{{scan}}

The video is clipped to the crash window, **{{from}} s to {{to}} s**, at 10 frames per second. Report every time on video 1's **full** timeline, not relative to the clip start.

For **each crash participant only**:

- **keyframes**: every 0.1–0.2 s from {{from}} s to {{to}} s (or while it is visible): footprint centre, heading and speed. These drive the reconstruction of the crash itself, so measure them carefully against lane lines and vehicle lengths.
- **forces**: the net horizontal force (`fx_n`, `fy_n`, plan frame, newtons) as the skill describes, at least every 0.25 s and at every change of `cause`. `note` is a few words on what you saw ("nose dives, brake lights on", "rear swings out").
- **rest**: where it finally stopped and which way it faces. null if it leaves the frame still moving.

Also:

- **start_s / end_s**: refine the crash period, from the first contact until all participants are at rest.
- **contacts**: every contact between two participants that you can **see**: the pair (`a`, `b`), the time, the contact point, and `normal_deg`, the direction of the push from a into b. Include secondary impacts only when you can see them happen; a scan event at low confidence is not enough.
- **caveats**: anything uncertain, such as occlusion, motion blur or a contact you inferred rather than saw.
