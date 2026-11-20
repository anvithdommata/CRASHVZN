# Merge the census

Several cameras watched the same incident, and each one listed the vehicles it saw (below, as `<video index>:<ref>`). The same vehicle often shows up in more than one camera. Group the entries so that each group is **one real vehicle**.

Cameras (with which way +x traffic moves in each picture):

{{views}}

The vehicles already reconstructed from the whole footage (match census groups to these when they are the same vehicle):

```json
{{objects}}
```

Census entries:

```json
{{census}}
```

Rules:

- Merge entries only when they are plausibly the same vehicle: same category and colour, the same direction of travel along the road, and timings that fit its speed and the cameras' order. When unsure, keep them apart.
- Every entry goes in exactly one group. Single-entry groups are fine.
- Set `matches_object_id` when the group is one of the reconstructed vehicles, otherwise null.
