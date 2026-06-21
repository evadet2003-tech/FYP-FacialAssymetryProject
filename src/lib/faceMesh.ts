import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

export type FacePoint = { x: number; y: number; z: number };

let detectorPromise: Promise<FaceLandmarker> | null = null;

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

async function createDetector() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
  );
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: "IMAGE",
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
}

export async function getDetector() {
  if (!detectorPromise) detectorPromise = createDetector();
  return detectorPromise;
}

export async function detectFaceMesh(image: HTMLImageElement): Promise<FacePoint[]> {
  const detector = await getDetector();
  const result = detector.detect(image);
  if (!result.faceLandmarks.length) return [];
  return result.faceLandmarks[0].map((point) => ({
    x: point.x,
    y: point.y,
    z: point.z,
  }));
}

