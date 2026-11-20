import type { SceneEnvironment } from "@/scene/environment";
import r05FootageUrl from "../../../../demo.mp4?url";

export type VehicleInfo = {
  id: string;
  label: string;
  color: string;
  /** "sedan" | "suv" | "truck" | "van" | "hatchback" — what people call it. */
  type: string;
  /** Other names people use: "car 1", "the SUV". */
  aliases?: string[];
  /**
   * Precision tier. "crash": involved in the crash, reconstructed precisely. "background": other
   * traffic, approximate (it may differ slightly between builds, but never touches the crash).
   */
  involvement?: "crash" | "background";
  /** Estimated mass (kg); falls back to a class default. */
  massKg?: number;
  /** When it is on the road (seconds); outside this it hasn't entered yet or has left. Absent = whole clip. */
  visibleFrom?: number;
  visibleTo?: number;
};

export type SceneInfo = {
  id: string;
  title: string;
  location: string;
  detail: string;
  duration: number;
  /** Start of the crash period (s): "before the crash" counts back from here. Null = no crash. */
  impactTime: number | null;
  /** End of the crash period (s), when the vehicles involved have come to rest. */
  crashEnd: number | null;
  /** Vehicles involved in the crash. */
  crashVehicles: string[];
  startTime: number;
  /** Library folder on the home screen. */
  folder: string;
  /** When the reconstruction was made (ISO date). */
  created: string;
  /** Original footage, played in sync with the timeline. */
  sourceVideo?: { url: string; name: string };
  kind: "proxy" | "splat";
  vehicles: VehicleInfo[];
  /** Sky, ground cover and snow, as detected from the scene's source footage. */
  environment: SceneEnvironment;
  /** The footage the environment was read from, when known. */
  environmentSource?: string;
  /** Where the motion comes from, stored with the kinematics and passed on to the assistant. */
  basis?: string;
  /** Road and air for the force breakdown: wind (scene frame, m/s), grade (%), surface and friction. */
  physics?: { wind: [number, number, number]; gradePercent: number; surface: string; mu: number };
  /** Forces the vision model read off the footage per vehicle (scene frame, N), stored next to the derived ones. */
  reportedForces?: Record<string, { t: number; force: [number, number, number]; cause: string; note: string }[]>;
};

const R05_ENVIRONMENT: SceneEnvironment = { sky: "overcast", snow: 0.44, vegetation: "dormant", road: "dry" };

export const BUILTIN_SCENES: SceneInfo[] = [
  {
    id: "roundabout",
    title: "Roundabout collision",
    location: "Site reconstruction",
    detail: "Preview · 4 vehicles",
    duration: 25,
    impactTime: 12,
    startTime: 10.86,
    crashEnd: 14,
    crashVehicles: ["red", "white"],
    folder: "Demo incidents",
    created: "2026-11-14",
    kind: "proxy",
    // No source footage bundled for this preview yet; analysed uploads will replace this.
    environment: { sky: "clear", snow: 0, vegetation: "green", road: "dry" },
    vehicles: [
      { id: "white", label: "White SUV", color: "#f4f4f4", type: "suv", aliases: ["car 2", "the suv"] },
      { id: "red", label: "Red sedan", color: "#d02424", type: "sedan", aliases: ["car 1"] },
      { id: "orange", label: "Orange hatchback", color: "#e07a14", type: "hatchback", aliases: ["car 3"] },
      { id: "green", label: "Green sedan", color: "#2f9e4f", type: "sedan", aliases: ["car 4"] },
    ],
  },
  {
    id: "apache",
    title: "Apache Blvd eastbound",
    location: "Apache Blvd, Tempe, AZ",
    detail: "Preview · 2 vehicles",
    duration: 16,
    impactTime: 8,
    startTime: 6.5,
    crashEnd: 10.4,
    crashVehicles: ["silver", "blue"],
    folder: "Demo incidents",
    created: "2026-11-14",
    kind: "proxy",
    // No source footage bundled for this preview yet; analysed uploads will replace this.
    environment: { sky: "clear", snow: 0, vegetation: "arid", road: "dry" },
    vehicles: [
      { id: "silver", label: "Silver sedan", color: "#d5dbe3", type: "sedan", aliases: ["car 1", "the sedan"] },
      { id: "blue", label: "Blue SUV", color: "#1d4e89", type: "suv", aliases: ["car 2", "the suv"] },
    ],
  },
  {
    id: "highway",
    title: "Divided highway traffic",
    location: "r05 · camera set s03",
    detail: "Preview · 10 vehicles",
    duration: 30,
    impactTime: null,
    crashEnd: null,
    crashVehicles: [],
    startTime: 0,
    folder: "Traffic studies",
    created: "2026-11-13",
    sourceVideo: { url: r05FootageUrl, name: "r05_s03_labels_visualization.mp4" },
    kind: "proxy",
    // Output of analyzeFootage() on r05_s03_labels_visualization.mp4.
    environment: R05_ENVIRONMENT,
    environmentSource: "r05_s03_labels_visualization.mp4",
    vehicles: [
      { id: "e-truck", label: "White truck", color: "#e9ecef", type: "truck" },
      { id: "e-van", label: "White van", color: "#f2f2f0", type: "van" },
      { id: "e-silver", label: "Silver sedan", color: "#c4c9cf", type: "sedan" },
      { id: "e-graphite", label: "Graphite sedan", color: "#4a4f57", type: "sedan", aliases: ["grey sedan", "gray sedan"] },
      { id: "e-black", label: "Black sedan", color: "#1c1e22", type: "sedan" },
      { id: "e-red", label: "Red sedan", color: "#b3202a", type: "sedan" },
      { id: "w-white", label: "White sedan", color: "#eceff1", type: "sedan" },
      { id: "w-blue", label: "Blue sedan", color: "#24508f", type: "sedan" },
      { id: "w-truck", label: "Red-cab truck", color: "#b4372b", type: "truck", aliases: ["red truck"] },
      { id: "w-van", label: "Beige van", color: "#d8d4c8", type: "van" },
    ],
  },
];
