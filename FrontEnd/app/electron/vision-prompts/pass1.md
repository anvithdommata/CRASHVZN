# Pass 1: read the whole incident

Footage: {{video_count}} of the same incident, each preceded by its name, in this order:

{{video_list}}

Video 1 is the time reference. Give one entry in `views` per video, with `video_index` counting from 1 in the order above:

- `time_offset_s`: time on video 1 = time on that video + offset. Video 1 has offset 0.
- `plus_x_traffic`: in that camera's picture, does traffic travelling +x come **toward_camera** or go **away_from_camera** (or **not_visible**)? Work it out from the crash vehicles' direction. It's used to place every other vehicle on the right carriageway, so get it right for each camera.

`duration_s` is the length of the incident timeline, normally video 1's length.

## What the incident scan already found

A dense scan of every camera reported:

{{scan}}

If it reports a **contact** with confidence 0.5 or more, there is a crash. Find it, identify the vehicles involved, and report the crash with those vehicles as participants, unless you can clearly see it was not a contact (and then say why in caveats). Times may be off by a second or so; use your own reading of the footage for exact times.

## Report

- **environment_preset**: the closest of {{presets}}. It only sets the sky, ground cover and road wetness, so pick quickly.
- **road**: `kind` (straight, divided_highway, intersection or roundabout), `region` (US, DE or EU), `road_class`, lanes per direction on the main road and the cross road (1 if there is none), `surface`, `grade_percent` (rising toward +x; 0 if flat or unknown), and the posted limit in m/s if a sign is legible, else null.
- **wind**: only from visible cues (flags, rain, blowing debris). Otherwise speed 0. `toward_deg` is the direction it blows toward, in the plan frame.
- **crash**: from the first contact (`start_s`) until every vehicle involved has come to rest or driven clear (`end_s`). `participants` lists every object that touches another or is struck. null only if there is no contact.
- **objects**: the crash vehicles and the vehicles close to the crash, up to 25. A separate census counts all the other traffic camera by camera, so don't try to list every car here.
  - Several cameras often show the **same** vehicle. Merge them into one object; don't list it twice.
  - **Crash vehicles**: keyframes about every 0.5 s from at least 3 s before the crash until they stop or leave.
  - **Nearby background vehicles**: only 2–4 keyframes each (where it enters, any lane change or stop, where it leaves).
  - **Lateral position (y)**: right-hand traffic. A vehicle travelling +x drives at **negative y** (its lane next to the median is around y = -2 to -4 m on a divided road), and a vehicle travelling -x drives at positive y. A swerve toward the median moves a +x vehicle toward y = 0.
  - `color_hex` is the paint colour as #rrggbb.
- **caveats**: short notes on anything you couldn't see well or had to estimate indirectly.
