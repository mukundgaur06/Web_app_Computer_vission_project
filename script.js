// ---------------------------------------------------------
// PHASE 4 (v2): Gesture detection + Blade Trail / Smoke Bomb
// effects, built on top of Phase 3's hand tracking.
// ---------------------------------------------------------

import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";

const video = document.getElementById("webcam");
const canvas = document.getElementById("output-canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

let handLandmarker;
let lastVideoTime = -1;

// Smoke particles live here (same pattern as Phase 4's stars).
let smokeParticles = [];

// Blade trail points live here — this is an ORDERED list of recent
// fingertip positions, drawn as ONE connected line (not separate
// particles), so it looks like a continuous swipe.
let bladeTrail = [];
const MAX_TRAIL_LENGTH = 18; // how many points make up the trail

// ---------- SETUP (unchanged from Phase 3/4) ----------

async function initHandLandmarker() {
  statusEl.textContent = "Loading hand-tracking model...";

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
  });

  statusEl.textContent = "Model loaded. Starting camera...";
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });

    video.srcObject = stream;

    video.addEventListener("loadedmetadata", () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      statusEl.textContent = "Point and swipe for the blade. Fist for smoke!";
      requestAnimationFrame(renderLoop);
    });
  } catch (err) {
    console.error("Camera error:", err);
    statusEl.textContent = "Couldn't access the camera.";
  }
}

// ---------- MAIN LOOP ----------

function renderLoop() {
  if (handLandmarker && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;

    const result = handLandmarker.detectForVideo(video, performance.now());

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let handDetected = false;

    if (result.landmarks && result.landmarks.length > 0) {
      handDetected = true;
      for (const hand of result.landmarks) {
        handleGestures(hand);
      }
    }

    // If no hand (or no pointing) this frame, let the trail shrink
    // naturally instead of freezing mid-air.
    if (!handDetected) {
      decayBladeTrail();
    }

    drawBladeTrail();
    updateAndDrawSmoke();
  }

  requestAnimationFrame(renderLoop);
}

// ---------- GESTURE DETECTION (same as Phase 4) ----------

const FINGERS = {
  index: { tip: 8, pip: 6 },
  middle: { tip: 12, pip: 10 },
  ring: { tip: 16, pip: 14 },
  pinky: { tip: 20, pip: 18 },
};

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isFingerExtended(landmarks, tipIdx, pipIdx) {
  const wrist = landmarks[0];
  const tipDist = dist(landmarks[tipIdx], wrist);
  const pipDist = dist(landmarks[pipIdx], wrist);
  return tipDist > pipDist * 1.15;
}

function handleGestures(landmarks) {
  const indexExtended = isFingerExtended(landmarks, FINGERS.index.tip, FINGERS.index.pip);
  const middleExtended = isFingerExtended(landmarks, FINGERS.middle.tip, FINGERS.middle.pip);
  const ringExtended = isFingerExtended(landmarks, FINGERS.ring.tip, FINGERS.ring.pip);
  const pinkyExtended = isFingerExtended(landmarks, FINGERS.pinky.tip, FINGERS.pinky.pip);

  const extendedCount = [indexExtended, middleExtended, ringExtended, pinkyExtended]
    .filter(Boolean).length;

  const indexTip = landmarks[8];
  const px = indexTip.x * canvas.width;
  const py = indexTip.y * canvas.height;

  if (indexExtended && extendedCount === 1) {
    // POINTING gesture -> Blade Trail
    pushBladePoint(px, py);
  } else {
    // Not pointing this frame -> let the existing trail fade out
    decayBladeTrail();
  }

  if (extendedCount === 0) {
    // FIST gesture -> Smoke Bomb, from the wrist point
    const wrist = landmarks[0];
    const wx = wrist.x * canvas.width;
    const wy = wrist.y * canvas.height;
    spawnSmoke(wx, wy);
  }
}

// ---------- EFFECT 1: BLADE TRAIL ----------

// Add the current fingertip position to the trail.
// life = 1.0 means brand new; it fades as the point ages.
function pushBladePoint(x, y) {
  bladeTrail.push({ x, y, life: 1.0 });

  if (bladeTrail.length > MAX_TRAIL_LENGTH) {
    bladeTrail.shift(); // remove the oldest point
  }
}

// When you stop pointing, the trail should still shrink away
// smoothly instead of vanishing instantly.
function decayBladeTrail() {
  for (const p of bladeTrail) {
    p.life -= 0.08;
  }
  bladeTrail = bladeTrail.filter((p) => p.life > 0);
}

function drawBladeTrail() {
  if (bladeTrail.length < 2) return;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Draw the trail as many short connected segments so we can
  // taper the width and fade the opacity from tail -> tip.
  for (let i = 1; i < bladeTrail.length; i++) {
    const prev = bladeTrail[i - 1];
    const curr = bladeTrail[i];

    // Newer points (higher index) are thicker and brighter —
    // this is what gives it the "blade swipe" look.
    const progress = i / bladeTrail.length;
    const width = 2 + progress * 10;
    const alpha = progress * curr.life;

    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(curr.x, curr.y);

    ctx.strokeStyle = `rgba(191, 242, 255, ${alpha})`; // icy-cyan blade
    ctx.lineWidth = width;
    ctx.shadowColor = "#7dd3fc";
    ctx.shadowBlur = 15;
    ctx.stroke();
  }

  ctx.restore();
}

// ---------- EFFECT 2: SMOKE BOMB ----------

function spawnSmoke(x, y) {
  const puffCount = 2; // new puffs per frame while fist is held

  for (let i = 0; i < puffCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.3 + Math.random() * 0.8; // smoke drifts slowly

    smokeParticles.push({
      x: x + (Math.random() - 0.5) * 10,
      y: y + (Math.random() - 0.5) * 10,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 0.4, // slight upward drift
      size: 6 + Math.random() * 6,
      maxSize: 30 + Math.random() * 20,
      life: 1.0,
    });
  }
}

function drawSmoke(p) {
  ctx.save();
  ctx.globalAlpha = p.life * 0.5; // smoke is naturally semi-transparent
  ctx.filter = "blur(4px)"; // soft, cloud-like edges

  // Radial gradient makes each puff look soft in the middle,
  // fading out at the edges, instead of a flat grey circle.
  const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
  gradient.addColorStop(0, "rgba(200, 200, 205, 0.9)");
  gradient.addColorStop(1, "rgba(200, 200, 205, 0)");

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function updateAndDrawSmoke() {
  for (const p of smokeParticles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy *= 0.98; // gradually loses upward momentum, like real smoke

    if (p.size < p.maxSize) p.size += 0.6; // puffs grow as they rise
    p.life -= 0.012;

    drawSmoke(p);
  }

  smokeParticles = smokeParticles.filter((p) => p.life > 0);
}

// Kick everything off
initHandLandmarker().then(startCamera);
