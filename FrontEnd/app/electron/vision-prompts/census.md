# Vehicle census: {{camera}}

This is one camera of the incident ({{camera}}), the whole clip at 2 frames per second. List **every** vehicle that appears in it: moving, queued or stopped, near or far, in both directions. The reconstruction draws every vehicle you list and nothing you leave out, so be complete. Small, distant vehicles count.

Each vehicle once per appearance in this camera:

- `ref`: a short id unique within this camera ("c1", "c2", …).
- `category`, `color_name`, `color_hex` (#rrggbb).
- `toward_camera`: true if it drives toward the camera, false if away.
- `lane_from_median`: 1 for the lane next to the median barrier or centre line, 2 for the next one out, and so on.
- `first_seen_s` / `last_seen_s`: when it enters and leaves this camera's view, on the full timeline.
- `speed_mps`: its typical speed while visible. Measure it against the lane dashes as the skill describes.
- `stopped`: true if it is standing still for most of the time it's visible (in a queue or after a crash).

Ignore burned-in tracker boxes and labels; list the vehicles themselves. Don't stop early: go through the whole clip, lane by lane, both directions.
