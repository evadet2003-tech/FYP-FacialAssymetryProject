export type RegionKey =
  | "Eyes"
  | "Eyebrows"
  | "Nose"
  | "Mouth"
  | "Ears"
  | "UpperCheek"
  | "LowerCheek";

export type Landmark3D = { x: number; y: number; z: number };

export type FaceProfile = {
  genderPresentation: "Male" | "Female" | "Unspecified";
  ageEstimateYears: number;
  faceShape: "Oval" | "Round" | "Square" | "Heart" | "Oblong";
  skinToneCategory: "Light" | "Medium" | "Tan" | "Deep";
};

export type AnalysisResult = {
  analysisVersion: number;
  overallScore: number;
  asymmetryIndex: number;
  harmonyOverall: number;
  harmonyByRegion: Record<RegionKey, number>;
  severity: "Perfect" | "Mild" | "Moderate" | "Severe";
  worstRegion: RegionKey | string;
  scores: Record<RegionKey, number> & Record<string, number>;
  quality: number;
  confidence: number;
  profile?: FaceProfile;
  profileMethodNote?: string;
  recommendations: string[];
  timestamp: string;
};

export const REGION_KEYS: RegionKey[] = [
  "Eyes",
  "Eyebrows",
  "Nose",
  "Mouth",
  "Ears",
  "UpperCheek",
  "LowerCheek",
];

export const HARMONY_BREAKDOWN_ROWS: Array<{ key: RegionKey; label: string; emoji: string }> = [
  { key: "Eyes", label: "Eyes", emoji: "👁️" },
  { key: "Eyebrows", label: "Eyebrows", emoji: "〰️" },
  { key: "Nose", label: "Nose", emoji: "👃" },
  { key: "Mouth", label: "Mouth", emoji: "👄" },
  { key: "Ears", label: "Ears", emoji: "👂" },
  { key: "UpperCheek", label: "Upper Cheek", emoji: "😊" },
  { key: "LowerCheek", label: "Lower Cheek", emoji: "🫦" },
];

export const PROFILE_DISCLAIMER =
  "Gender presentation, age, face shape, and skin tone are heuristic estimates from geometry and pixels—not clinical facts. No algorithm can infer biological sex reliably from a single 2D image.";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (!values.length) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function toGrayscale(imageData: ImageData): Float32Array {
  const out = new Float32Array(imageData.width * imageData.height);
  for (let i = 0, j = 0; i < imageData.data.length; i += 4, j += 1) {
    const r = imageData.data[i];
    const g = imageData.data[i + 1];
    const b = imageData.data[i + 2];
    out[j] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return out;
}

function sampleVerticalBands(
  grayscale: Float32Array,
  width: number,
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number,
): number[] {
  const values: number[] = [];
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      values.push(grayscale[y * width + x]);
    }
  }
  return values;
}

function mirroredDiff(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (!length) return 0;
  let total = 0;
  for (let i = 0; i < length; i += 1) {
    total += Math.abs(left[i] - right[length - 1 - i]);
  }
  return total / length;
}

function normalizeScore(diff: number, gain: number): number {
  return clamp(((diff / 255) * gain) * 1000, 0, 1000);
}

function estimateImageQuality(grayscale: Float32Array, width: number, height: number): number {
  const gradient: number[] = [];
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const center = grayscale[y * width + x];
      const gx = grayscale[y * width + x + 1] - grayscale[y * width + x - 1];
      const gy = grayscale[(y + 1) * width + x] - grayscale[(y - 1) * width + x];
      gradient.push(Math.abs(center) * 0.01 + Math.sqrt(gx * gx + gy * gy));
    }
  }
  return clamp((mean(gradient) / 12) * 100, 1, 100);
}

function confidenceFromQuality(quality: number): number {
  return clamp(0.4 + quality / 140, 0.4, 0.99);
}

function fitMidline(points: Landmark3D[]): { slope: number; intercept: number } {
  const midlineIndices = [10, 151, 9, 8, 168, 6, 197, 195, 5, 4, 1, 2, 164, 0, 152];
  const selected = midlineIndices.map((i) => points[i]).filter(Boolean);
  if (selected.length < 2) return { slope: 0, intercept: 0.5 };
  const ys = selected.map((p) => p.y);
  const xs = selected.map((p) => p.x);
  const yMean = mean(ys);
  const xMean = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < ys.length; i += 1) {
    num += (ys[i] - yMean) * (xs[i] - xMean);
    den += (ys[i] - yMean) ** 2;
  }
  let slope = den === 0 ? 0 : num / den;
  let intercept = xMean - slope * yMean;
  if (Math.abs(slope) > 0.42) {
    slope = 0;
    intercept = mean(xs);
  }
  return { slope, intercept };
}

/** Reflect point across sagittal line x = slope*y + intercept (regression form). */
function reflectAcrossMidline(p: Landmark3D, slope: number, intercept: number): { x: number; y: number } {
  const A = 1;
  const B = -slope;
  const C = -intercept;
  const d = A * p.x + B * p.y + C;
  const denom = A * A + B * B;
  if (denom < 1e-14) return { x: p.x, y: p.y };
  return {
    x: p.x - (2 * A * d) / denom,
    y: p.y - (2 * B * d) / denom,
  };
}

function dist2(a: Landmark3D, b: Landmark3D): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Bidirectional planar mismatch: averages error(left vs reflect(right)) and error(right vs reflect(left)). */
function bilateralPlanarAsymmetry(
  lp: Landmark3D,
  rp: Landmark3D,
  slope: number,
  intercept: number,
  refW: number,
): number {
  const refR = reflectAcrossMidline(rp, slope, intercept);
  const refL = reflectAcrossMidline(lp, slope, intercept);
  const dLR = Math.hypot(lp.x - refR.x, lp.y - refR.y) / refW;
  const dRL = Math.hypot(rp.x - refL.x, rp.y - refL.y) / refW;
  return (dLR + dRL) * 0.5;
}

function winsorizedWeightedMean(values: number[], weights: number[], trimRatio: number): number {
  if (!values.length) return 0;
  const paired = values.map((v, i) => ({ v, w: Math.max(1e-6, weights[i] ?? 1) }));
  paired.sort((a, b) => a.v - b.v);
  const n = paired.length;
  const k = Math.max(0, Math.floor(n * trimRatio));
  const core = paired.slice(k, Math.max(k + 1, n - k));
  const sw = core.reduce((s, x) => s + x.w, 0);
  return core.reduce((s, x) => s + x.v * x.w, 0) / sw;
}

function weightedStdDev(values: number[], weights: number[], wMean: number): number {
  const ws = weights.map((w) => Math.max(1e-6, w));
  const sw = ws.reduce((a, b) => a + b, 0);
  if (sw < 1e-9) return 0;
  return Math.sqrt(values.reduce((s, v, i) => s + ws[i] * (v - wMean) ** 2, 0) / sw);
}

export function harmonyPercentFromAsymmetry(score: number): number {
  return Number(clamp(100 - (score / 1000) * 100, 0, 100).toFixed(1));
}

function asymmetryToHarmony(score: number): number {
  return harmonyPercentFromAsymmetry(score);
}

function classifySeverity(score: number): AnalysisResult["severity"] {
  if (score < 100) return "Perfect";
  if (score < 350) return "Mild";
  if (score < 650) return "Moderate";
  return "Severe";
}

function samplePatchMeanLuma(imageData: ImageData, cx: number, cy: number, r: number): number {
  const w = imageData.width;
  const h = imageData.height;
  let sum = 0;
  let n = 0;
  for (let dy = -r; dy <= r; dy += 2) {
    for (let dx = -r; dx <= r; dx += 2) {
      const x = clamp(Math.floor(cx + dx), 0, w - 1);
      const y = clamp(Math.floor(cy + dy), 0, h - 1);
      const i = (y * w + x) * 4;
      const lum = 0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2];
      sum += lum;
      n += 1;
    }
  }
  return n ? sum / n : 128;
}

function estimateSkinToneCategory(imageData: ImageData, points: Landmark3D[]): FaceProfile["skinToneCategory"] {
  const w = imageData.width;
  const h = imageData.height;
  const sampleIdx = [123, 352, 50, 280, 205, 425];
  let sum = 0;
  let n = 0;
  for (const idx of sampleIdx) {
    const p = points[idx];
    if (!p) continue;
    sum += samplePatchMeanLuma(imageData, p.x * w, p.y * h, 5);
    n += 1;
  }
  const L = n ? sum / n : 130;
  if (L >= 172) return "Light";
  if (L >= 132) return "Medium";
  if (L >= 92) return "Tan";
  return "Deep";
}

function estimateFaceShape(points: Landmark3D[], refWidth: number, faceHeight: number): FaceProfile["faceShape"] {
  const fh = faceHeight || 0.001;
  const wh = refWidth / fh;
  const jawW = dist2(points[58], points[288]);
  const browOuter = dist2(points[107], points[336]);
  const jawToBrow = jawW / (browOuter || 0.001);
  if (wh >= 0.8) return "Round";
  if (wh <= 0.58) return "Oblong";
  if (jawToBrow >= 0.96) return "Square";
  if (browOuter > jawW * 1.06) return "Heart";
  return "Oval";
}

/**
 * Multi-ratio geometric sex-presentation heuristic from frontal landmarks (not biological sex).
 * Combines jaw–cheek proportions, chin breadth, lower-third height, IOD ratio, and brow metrics.
 */
function estimateGenderPresentation(
  points: Landmark3D[],
  refWidth: number,
  faceHeight: number,
): FaceProfile["genderPresentation"] {
  const q = (i: number) => points[i];
  const fh = faceHeight > 1e-6 ? faceHeight : 1;
  const rw = refWidth > 1e-6 ? refWidth : 1;
  if (!q(33) || !q(263) || !q(152) || !q(10) || !q(234) || !q(454)) return "Unspecified";

  const cheekW = dist2(q(234)!, q(454)!) || rw;
  const jawW = dist2(q(58)!, q(288)!) || cheekW * 0.88;
  const jawToCheek = jawW / cheekW;

  const chinSpan =
    q(148) && q(377) ? dist2(q(148)!, q(377)!) : jawW * 0.92;
  const chinToCheek = chinSpan / cheekW;

  const iod = dist2(q(33)!, q(263)!);
  const iodRatio = iod / cheekW;

  const noseBase = q(2) ?? q(168) ?? q(6);
  const lowerThird = noseBase ? Math.abs(q(152)!.y - noseBase.y) / fh : 0.34;
  const upperThird = q(10) && q(168) ? Math.abs(q(10)!.y - q(168)!.y) / fh : 0.28;
  const lowerToUpper = lowerThird / (upperThird + 0.06);

  const browEye =
    q(70) && q(159) ? Math.abs(q(70)!.y - q(159)!.y) / rw : q(105) && q(159) ? Math.abs(q(105)!.y - q(159)!.y) / rw : 0.05;
  const browR = q(334) && q(386) ? Math.abs(q(334)!.y - q(386)!.y) / rw : browEye;

  const foreheadH =
    q(10) && q(70) ? Math.abs(q(10)!.y - q(70)!.y) / fh : q(10) && q(336) ? Math.abs(q(10)!.y - q(336)!.y) / fh : 0.26;

  const gonialFlare = cheekW > 1e-6 ? jawW / cheekW - chinSpan / cheekW : 0;

  let score = 0;
  score += clamp((jawToCheek - 0.855) * 4.5, -1.15, 1.15);
  score += clamp((chinToCheek - 0.765) * 3.2, -1, 1);
  score += clamp((0.355 - iodRatio) * 3.0, -1, 1);
  score += clamp((lowerThird - 0.315) * 3.8, -1.1, 1.1);
  score += clamp((lowerToUpper - 1.02) * 1.35, -0.85, 0.85);
  score += clamp((Math.max(browEye, browR) - 0.052) * 11, -0.95, 0.95);
  score += clamp((foreheadH - 0.265) * 2.4, -0.75, 0.75);
  score += clamp(gonialFlare * 2.2, -0.65, 0.65);

  const avg = score / 8;
  if (avg >= 0.2) return "Male";
  if (avg <= -0.2) return "Female";
  return "Unspecified";
}

function estimateAgeYears(points: Landmark3D[], refWidth: number, faceHeight: number): number {
  const eyeOpen =
    Math.abs((points[159]?.y ?? 0) - (points[145]?.y ?? 0)) / (refWidth || 0.001);
  const ratio = faceHeight / (refWidth || 0.001);
  let age = 22 + (ratio - 1.05) * 28 + (0.035 - eyeOpen) * 120;
  const chinY = points[152]?.y ?? 0;
  const topY = points[10]?.y ?? 0;
  age += chinY - topY > 0.42 ? 4 : 0;
  return clamp(Math.round(age), 18, 72);
}

function buildFaceProfile(imageData: ImageData | null, points: Landmark3D[], refWidth: number): FaceProfile {
  const faceHeight = dist2(points[10], points[152]);
  const skin = imageData ? estimateSkinToneCategory(imageData, points) : "Medium";
  return {
    genderPresentation: estimateGenderPresentation(points, refWidth, faceHeight),
    ageEstimateYears: estimateAgeYears(points, refWidth, faceHeight),
    faceShape: estimateFaceShape(points, refWidth, faceHeight),
    skinToneCategory: skin,
  };
}

/** Merge legacy saved results (v1 keys) for UI/compare. */
export function normalizeScoresForCompare(scores: Record<string, number>): Record<RegionKey, number> {
  const s: Record<string, number> = { ...scores };
  if (s.Mouth == null && typeof s.Lips === "number") s.Mouth = s.Lips;
  if (s.LowerCheek == null && typeof s.Jawline === "number") s.LowerCheek = s.Jawline;
  if (s.UpperCheek == null) {
    const eyes = typeof s.Eyes === "number" ? s.Eyes : 0;
    const nose = typeof s.Nose === "number" ? s.Nose : 0;
    s.UpperCheek = eyes || nose ? (eyes + nose) / 2 : 0;
  }
  if (s.Ears == null) {
    const eyes = typeof s.Eyes === "number" ? s.Eyes : 0;
    const mouth = typeof s.Mouth === "number" ? s.Mouth : 0;
    s.Ears = eyes || mouth ? (eyes + mouth) / 2 : 0;
  }
  const out = {} as Record<RegionKey, number>;
  for (const k of REGION_KEYS) {
    out[k] = typeof s[k] === "number" ? s[k] : 0;
  }
  return out;
}

function buildRecommendations(result: Omit<AnalysisResult, "recommendations">): string[] {
  const norm = normalizeScoresForCompare(result.scores as Record<string, number>);
  const items: string[] = [];
  items.push(`Primary region for focus: ${result.worstRegion}.`);
  if (result.quality < 45) items.push("Capture a brighter and sharper frontal image for better confidence.");
  if (result.confidence < 0.65) items.push("Low confidence run: repeat capture with neutral expression and centered head pose.");
  if (norm.Nose > 420) items.push("Consider profile-based nasal proportion review for deeper assessment.");
  if (norm.LowerCheek > 420) items.push("Lower cheek / jaw balance may warrant occlusal and mandibular review.");
  if (norm.Eyes > 420) items.push("Orbital asymmetry trend detected; inspect brow-lid relationship.");
  if (norm.Mouth > 420) items.push("Oral commissure and lip balance review can refine perioral assessment.");
  if (norm.Ears > 420) items.push("Pinna / lateral face framing asymmetry trend—verify head yaw and hair occlusion.");
  if (norm.UpperCheek > 420) items.push("Midface volume balance review can clarify cheek prominence differences.");
  if (result.overallScore < 250) items.push("Overall asymmetry is in mild range; monitor with periodic baseline scans.");
  if (items.length < 5) items.push("Use consistency mode for repeat scans under similar light and camera angle.");
  return items.slice(0, 6);
}

/** Legacy pixel-based path (approximate); kept for API compatibility. */
export function analyzeFacialImage(imageData: ImageData): AnalysisResult {
  const { width, height } = imageData;
  const grayscale = toGrayscale(imageData);
  const midX = Math.floor(width / 2);
  const eyesYStart = Math.floor(height * 0.22);
  const eyesYEnd = Math.floor(height * 0.42);
  const browYStart = Math.floor(height * 0.14);
  const browYEnd = Math.floor(height * 0.25);
  const noseYStart = Math.floor(height * 0.34);
  const noseYEnd = Math.floor(height * 0.62);
  const mouthYStart = Math.floor(height * 0.58);
  const mouthYEnd = Math.floor(height * 0.78);
  const cheekYStart = Math.floor(height * 0.35);
  const cheekYEnd = Math.floor(height * 0.62);
  const lowerYStart = Math.floor(height * 0.55);
  const lowerYEnd = Math.floor(height * 0.92);
  const earYStart = Math.floor(height * 0.28);
  const earYEnd = Math.floor(height * 0.55);

  const leftEyes = sampleVerticalBands(grayscale, width, Math.floor(width * 0.14), midX, eyesYStart, eyesYEnd);
  const rightEyes = sampleVerticalBands(grayscale, width, midX, Math.floor(width * 0.86), eyesYStart, eyesYEnd);
  const leftBrows = sampleVerticalBands(grayscale, width, Math.floor(width * 0.12), midX, browYStart, browYEnd);
  const rightBrows = sampleVerticalBands(grayscale, width, midX, Math.floor(width * 0.88), browYStart, browYEnd);
  const leftNose = sampleVerticalBands(grayscale, width, Math.floor(width * 0.28), midX, noseYStart, noseYEnd);
  const rightNose = sampleVerticalBands(grayscale, width, midX, Math.floor(width * 0.72), noseYStart, noseYEnd);
  const leftMouth = sampleVerticalBands(grayscale, width, Math.floor(width * 0.2), midX, mouthYStart, mouthYEnd);
  const rightMouth = sampleVerticalBands(grayscale, width, midX, Math.floor(width * 0.8), mouthYStart, mouthYEnd);
  const leftEar = sampleVerticalBands(grayscale, width, Math.floor(width * 0.06), midX, earYStart, earYEnd);
  const rightEar = sampleVerticalBands(grayscale, width, midX, Math.floor(width * 0.94), earYStart, earYEnd);
  const leftUpper = sampleVerticalBands(grayscale, width, Math.floor(width * 0.18), midX, cheekYStart, cheekYEnd);
  const rightUpper = sampleVerticalBands(grayscale, width, midX, Math.floor(width * 0.82), cheekYStart, cheekYEnd);
  const leftLower = sampleVerticalBands(grayscale, width, Math.floor(width * 0.1), midX, lowerYStart, lowerYEnd);
  const rightLower = sampleVerticalBands(grayscale, width, midX, Math.floor(width * 0.9), lowerYStart, lowerYEnd);

  const scores: Record<RegionKey, number> = {
    Eyes: normalizeScore(mirroredDiff(leftEyes, rightEyes), 3.8),
    Eyebrows: normalizeScore(mirroredDiff(leftBrows, rightBrows), 3.2),
    Nose: normalizeScore(mirroredDiff(leftNose, rightNose), 4.8),
    Mouth: normalizeScore(mirroredDiff(leftMouth, rightMouth), 4.2),
    Ears: normalizeScore(mirroredDiff(leftEar, rightEar), 3.4),
    UpperCheek: normalizeScore(mirroredDiff(leftUpper, rightUpper), 3.6),
    LowerCheek: normalizeScore(mirroredDiff(leftLower, rightLower), 3.5),
  };

  const regionWeights: Record<RegionKey, number> = {
    Eyes: 0.18,
    Eyebrows: 0.12,
    Nose: 0.2,
    Mouth: 0.16,
    Ears: 0.1,
    UpperCheek: 0.12,
    LowerCheek: 0.12,
  };
  const overallScore = Number(
    REGION_KEYS.reduce((acc, k) => acc + scores[k] * regionWeights[k], 0).toFixed(1),
  );
  const harmonyByRegion = Object.fromEntries(
    REGION_KEYS.map((k) => [k, asymmetryToHarmony(scores[k])]),
  ) as Record<RegionKey, number>;
  const harmonyOverall = asymmetryToHarmony(overallScore);
  const asymmetryIndex = Number(clamp((overallScore / 1000) * 100, 0, 100).toFixed(2));
  const severity = classifySeverity(overallScore);
  const worstRegion = [...REGION_KEYS].sort((a, b) => scores[b] - scores[a])[0];
  const quality = estimateImageQuality(grayscale, width, height);
  const confidence = confidenceFromQuality(quality);
  const timestamp = new Date().toISOString();
  const placeholderProfile: FaceProfile = {
    genderPresentation: "Unspecified",
    ageEstimateYears: 30,
    faceShape: "Oval",
    skinToneCategory: "Medium",
  };
  const baseResult = {
    analysisVersion: 2,
    overallScore,
    asymmetryIndex,
    harmonyOverall,
    harmonyByRegion,
    severity,
    worstRegion,
    scores: Object.fromEntries(
      Object.entries(scores).map(([key, value]) => [key, Number(value.toFixed(1))]),
    ) as Record<RegionKey, number>,
    quality: Number(quality.toFixed(1)),
    confidence: Number(confidence.toFixed(2)),
    profile: placeholderProfile,
    profileMethodNote: PROFILE_DISCLAIMER,
    timestamp,
  };
  return { ...baseResult, recommendations: buildRecommendations(baseResult) };
}

/** Homologous left/right indices (subject’s left first). Optional weight biases landmark influence per region. */
const SYMMETRY_PAIRS: Array<[number, number, RegionKey, number]> = [
  [33, 263, "Eyes", 1.25],
  [133, 362, "Eyes", 1.2],
  [159, 386, "Eyes", 1.15],
  [145, 374, "Eyes", 1.1],
  [158, 385, "Eyes", 1.05],
  [153, 380, "Eyes", 1.05],
  [157, 384, "Eyes", 1],
  [173, 398, "Eyes", 1],
  [246, 466, "Eyes", 1.2],
  [160, 387, "Eyes", 0.95],
  [161, 388, "Eyes", 0.95],
  [144, 381, "Eyes", 0.95],
  [70, 300, "Eyebrows", 1.1],
  [105, 334, "Eyebrows", 1.05],
  [107, 336, "Eyebrows", 1.15],
  [66, 296, "Eyebrows", 0.95],
  [63, 293, "Eyebrows", 0.95],
  [55, 285, "Eyebrows", 0.9],
  [65, 295, "Eyebrows", 0.9],
  [52, 282, "Eyebrows", 0.85],
  [79, 309, "Nose", 1.2],
  [98, 327, "Nose", 1.15],
  [64, 294, "Nose", 1.05],
  [102, 331, "Nose", 1.05],
  [215, 436, "Nose", 1],
  [206, 426, "Nose", 0.95],
  [203, 423, "Nose", 0.9],
  [240, 460, "Nose", 0.85],
  [61, 291, "Mouth", 1.25],
  [78, 308, "Mouth", 1.15],
  [95, 324, "Mouth", 1.15],
  [185, 409, "Mouth", 1.05],
  [40, 270, "Mouth", 1.05],
  [37, 267, "Mouth", 1],
  [39, 269, "Mouth", 1],
  [146, 375, "Mouth", 1.1],
  [184, 408, "Mouth", 1.05],
  [83, 314, "Mouth", 1.05],
  [181, 405, "Mouth", 1],
  [191, 415, "Mouth", 0.95],
  [127, 356, "Ears", 1.05],
  [162, 389, "Ears", 1.05],
  [234, 454, "Ears", 0.85],
  [116, 345, "UpperCheek", 1.15],
  [205, 425, "UpperCheek", 1.2],
  [123, 352, "UpperCheek", 1.2],
  [101, 330, "UpperCheek", 1],
  [118, 347, "UpperCheek", 1.05],
  [50, 280, "UpperCheek", 1.1],
  [187, 411, "UpperCheek", 1.05],
  [209, 429, "UpperCheek", 0.9],
  [198, 420, "UpperCheek", 0.9],
  [132, 361, "LowerCheek", 1.2],
  [148, 377, "LowerCheek", 1.15],
  [172, 397, "LowerCheek", 1.2],
  [58, 288, "LowerCheek", 1.1],
  [136, 365, "LowerCheek", 1.05],
  [150, 380, "LowerCheek", 1],
  [176, 400, "LowerCheek", 1],
  [149, 378, "LowerCheek", 1],
  [93, 323, "LowerCheek", 0.95],
];

export function analyzeFaceLandmarks(points: Landmark3D[], imageData?: ImageData | null): AnalysisResult | null {
  if (points.length < 455) return null;
  const refPairA = points[234];
  const refPairB = points[454];
  const refWidth = Math.hypot(refPairA.x - refPairB.x, refPairA.y - refPairB.y, refPairA.z - refPairB.z) || 1;
  const { slope, intercept } = fitMidline(points);

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const coverage = clamp(((maxX - minX) * (maxY - minY)) / 0.24, 0, 1);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centering = clamp(1 - Math.hypot(centerX - 0.5, centerY - 0.5) * 1.6, 0, 1);
  const eyeLeft = points[33];
  const eyeRight = points[263];
  const rollDeg = Math.abs(Math.atan2(eyeRight.y - eyeLeft.y, eyeRight.x - eyeLeft.x) * (180 / Math.PI));
  const rollPenalty = clamp(1 - rollDeg / 22, 0, 1);
  const quality = Number((clamp((coverage * 0.45 + centering * 0.35 + rollPenalty * 0.2) * 100, 1, 100)).toFixed(1));

  const noseTip = points[1];
  let poseScale = 1;
  if (noseTip) {
    const midXAtNose = slope * noseTip.y + intercept;
    const yawOff = Math.abs(noseTip.x - midXAtNose) / refWidth;
    const yawDampen = clamp(1 / (1 + yawOff * 5.8), 0.52, 1);
    const rollRad = (rollDeg * Math.PI) / 180;
    const rollDampen = clamp(1 - Math.min(0.38, Math.abs(Math.sin(rollRad)) * 0.45), 0.55, 1);
    poseScale = clamp(yawDampen * rollDampen, 0.45, 1);
  }

  const buckets: Record<RegionKey, { v: number[]; w: number[] }> = {
    Eyes: { v: [], w: [] },
    Eyebrows: { v: [], w: [] },
    Nose: { v: [], w: [] },
    Mouth: { v: [], w: [] },
    Ears: { v: [], w: [] },
    UpperCheek: { v: [], w: [] },
    LowerCheek: { v: [], w: [] },
  };
  for (const [l, r, region, pairWeight] of SYMMETRY_PAIRS) {
    const lp = points[l];
    const rp = points[r];
    if (!lp || !rp || pairWeight <= 0) continue;
    const planar = bilateralPlanarAsymmetry(lp, rp, slope, intercept, refWidth);
    const depth = (Math.abs(lp.z - rp.z) / refWidth) * 0.88;
    const verticalHomolog = Math.abs(lp.y - rp.y) / refWidth;
    let raw = clamp(planar * 0.57 + depth * 0.15 + verticalHomolog * 0.09, 0, 2.35);
    raw *= poseScale;
    buckets[region].v.push(raw);
    buckets[region].w.push(pairWeight);
  }

  const sensitivities: Record<RegionKey, number> = {
    Eyes: 0.044,
    Eyebrows: 0.054,
    Nose: 0.037,
    Mouth: 0.048,
    Ears: 0.058,
    UpperCheek: 0.051,
    LowerCheek: 0.07,
  };

  const scores = Object.fromEntries(
    REGION_KEYS.map((region) => {
      const bucket = buckets[region];
      if (!bucket.v.length) return [region, 0];
      const wMean = winsorizedWeightedMean(bucket.v, bucket.w, 0.11);
      const wSpread = weightedStdDev(bucket.v, bucket.w, wMean);
      const robustAvg = wMean * (1 + clamp(wSpread * 0.32, 0, 0.2));
      const noiseFloor = 0.00072;
      const normalized = clamp(((wMean - noiseFloor) / sensitivities[region]) * 1000, 0, 1000);
      const robustScore = clamp(((robustAvg - noiseFloor) / sensitivities[region]) * 1000, 0, 1000);
      const finalRegionScore = normalized * 0.64 + robustScore * 0.36;
      return [region, Number(clamp(finalRegionScore, 0, 1000).toFixed(1))];
    }),
  ) as Record<RegionKey, number>;

  const regionWeights: Record<RegionKey, number> = {
    Eyes: 0.18,
    Eyebrows: 0.12,
    Nose: 0.2,
    Mouth: 0.16,
    Ears: 0.1,
    UpperCheek: 0.12,
    LowerCheek: 0.12,
  };

  const overallScore = Number(
    REGION_KEYS.reduce((acc, k) => acc + scores[k] * regionWeights[k], 0).toFixed(1),
  );
  const harmonyByRegion = Object.fromEntries(
    REGION_KEYS.map((k) => [k, asymmetryToHarmony(scores[k])]),
  ) as Record<RegionKey, number>;
  const harmonyOverall = asymmetryToHarmony(overallScore);
  const asymmetryIndex = Number(clamp((overallScore / 1000) * 100, 0, 100).toFixed(2));
  const severity = classifySeverity(overallScore);
  const worstRegion = [...REGION_KEYS].sort((a, b) => scores[b] - scores[a])[0];
  const pairVariance = stdDev(Object.values(scores));
  const stability = clamp(1 - pairVariance / 380, 0, 1);
  const poseConfidenceFactor = clamp(0.55 + Math.sqrt(poseScale) * 0.45, 0.55, 1);
  const confidence = Number(
    clamp(
      confidenceFromQuality(quality) * (0.72 + stability * 0.28) * poseConfidenceFactor,
      0.35,
      0.99,
    ).toFixed(2),
  );
  const timestamp = new Date().toISOString();
  const profile = buildFaceProfile(imageData ?? null, points, refWidth);

  const baseResult = {
    analysisVersion: 4,
    overallScore,
    asymmetryIndex,
    harmonyOverall,
    harmonyByRegion,
    severity,
    worstRegion,
    scores,
    quality,
    confidence,
    profile,
    profileMethodNote: PROFILE_DISCLAIMER,
    timestamp,
  };
  return { ...baseResult, recommendations: buildRecommendations(baseResult) };
}

export function getResolvedHarmony(result: AnalysisResult): Record<RegionKey, number> {
  if (
    result.harmonyByRegion &&
    REGION_KEYS.every((k) => typeof result.harmonyByRegion[k] === "number")
  ) {
    return result.harmonyByRegion;
  }
  const norm = normalizeScoresForCompare(result.scores as Record<string, number>);
  return Object.fromEntries(REGION_KEYS.map((k) => [k, harmonyPercentFromAsymmetry(norm[k])])) as Record<
    RegionKey,
    number
  >;
}

export const DEFAULT_FACE_PROFILE: FaceProfile = {
  genderPresentation: "Unspecified",
  ageEstimateYears: 30,
  faceShape: "Oval",
  skinToneCategory: "Medium",
};

export function resolveFaceProfile(result: AnalysisResult): FaceProfile {
  const p = result.profile;
  if (p && typeof p.ageEstimateYears === "number") {
    return p;
  }
  return { ...DEFAULT_FACE_PROFILE };
}

export function getResolvedHarmonyOverall(result: AnalysisResult): number {
  if (typeof result.harmonyOverall === "number") {
    return result.harmonyOverall;
  }
  return harmonyPercentFromAsymmetry(result.overallScore);
}

export function scoreVariance(result: AnalysisResult): number {
  const norm = normalizeScoresForCompare(result.scores as Record<string, number>);
  return Number(stdDev(REGION_KEYS.map((k) => norm[k])).toFixed(2));
}

export function exportResultCsv(result: AnalysisResult): string {
  const profile = resolveFaceProfile(result);
  const harmonyOv = getResolvedHarmonyOverall(result);
  const harmonyRows = getResolvedHarmony(result);
  const normScores = normalizeScoresForCompare(result.scores as Record<string, number>);
  const lines = [
    "Metric,Value",
    `Analysis Version,${result.analysisVersion ?? 1}`,
    `Overall Asymmetry (0-1000),${result.overallScore}`,
    `Harmony Overall (%),${harmonyOv}`,
    `Asymmetry Index (%),${result.asymmetryIndex}`,
    `Severity,${result.severity}`,
    `Worst Region,${result.worstRegion}`,
    `Image Quality,${result.quality}`,
    `Confidence,${result.confidence}`,
    `Gender (estimate),${profile.genderPresentation}`,
    `Age (estimate yrs),${profile.ageEstimateYears}`,
    `Face Shape (estimate),${profile.faceShape}`,
    `Skin Tone (estimate),${profile.skinToneCategory}`,
    ...REGION_KEYS.map((k) => [`Harmony ${k} (%)`, String(harmonyRows[k])].join(",")),
    ...REGION_KEYS.map((k) => [`Asymmetry ${k} (0-1000)`, String(normScores[k])].join(",")),
  ];
  return lines.join("\n");
}
