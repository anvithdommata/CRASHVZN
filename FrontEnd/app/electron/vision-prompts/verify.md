# Close look: did a collision happen?

A quick scan of this camera flagged something:

> {{claim}}

The video is clipped to **{{from}} s to {{to}} s**, at 10 frames per second. Watch it frame by frame and decide whether two vehicles, or a vehicle and a barrier, **physically touched**.

- `collision`: true only if you can see contact itself, or its unmistakable result: a vehicle knocked sideways, crumpled or spinning, or parts flying off at the moment two vehicles meet. Vehicles passing close, braking hard or queuing are **not** collisions.
- `first_contact_s`: the first frame of contact, on the full timeline (this clip starts at {{from}} s). null if there was no collision.
- `vehicles`: colour and type of each vehicle involved (and "median barrier" or "guardrail" if a vehicle hit one).
- `lane`: where it happened, e.g. "lane next to the median, traffic moving toward the camera".
- `description`: two or three sentences on what you saw, before and after.
- `confidence`: 0–1.

If the scan was wrong, say so plainly: `collision: false`, with what really happened in `description`.
