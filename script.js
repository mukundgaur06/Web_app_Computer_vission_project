// ---------------------------------------------------------
// PHASE 5: Fruit Ninja-style blade + falling fruits + score
// Builds on Phase 3 (hand tracking) and Phase 4 (gestures).
// ---------------------------------------------------------

import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";

const video = document.getElementById("webcam");
const canvas = document.getElementById("output-canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const scoreEl = document.getElementById("score");
const highScoreEl = document.getElementById("high-score");
const levelEl = document.getElementById("level");

let handLandmarker;
let lastVideoTime = -1;

// ---------- SCORE (persisted with localStorage) ----------
// localStorage keeps data even after you close the browser tab —
// perfect for a simple "high score" that survives between sessions.
let score = 0;
let highScore = Number(localStorage.getItem("magicCanvasHighScore")) || 0;
highScoreEl.textContent = `Best: ${highScore}`;

function addScore(points) {
  score += points;
  scoreEl.textContent = `Score: ${score}`;
  levelEl.textContent = `Speed: x${getDifficultyMultiplier().toFixed(2)}`;

  if (score > highScore) {
    highScore = score;
    highScoreEl.textContent = `Best: ${highScore}`;
    localStorage.setItem("magicCanvasHighScore", String(highScore));
  }
}

// ---------- BLADE TRAIL ----------
let bladeTrail = [];
const MAX_TRAIL_LENGTH = 14;

// ---------- FRUITS ----------
let fruits = [];
const FRUIT_TYPES = [
  { color: "#ef4444", innerColor: "#fecaca", name: "apple" },
  { color: "#f97316", innerColor: "#fed7aa", name: "orange" },
  { color: "#84cc16", innerColor: "#ecfccb", name: "melon" },
  { color: "#a855f7", innerColor: "#e9d5ff", name: "plum" },
];
let fruitSpawnTimer = 0;
const FRUIT_SPAWN_INTERVAL = 55; // lower = fruits spawn more often (in frames)

// Sliced fruit halves that fly apart — purely visual, not interactive
let fruitPieces = [];

// ---------- SETUP ----------

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
      video: { width: 1280, height: 720 },
      audio: false,
    });

    video.srcObject = stream;

    video.addEventListener("loadedmetadata", () => {
      resizeCanvasToWindow();
      statusEl.textContent = "Point your finger and slice the fruit!";
      requestAnimationFrame(renderLoop);
    });
  } catch (err) {
    console.error("Camera error:", err);
    statusEl.textContent = "Couldn't access the camera.";
  }
}

// Canvas must match the actual browser window size now (full-screen),
// not the video's native resolution — CSS "object-fit: cover" handles
// scaling the video, and our canvas coordinate math below accounts
// for the mirrored, full-screen video display.
function resizeCanvasToWindow() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvasToWindow);

// ---------- MAIN LOOP ----------

function renderLoop() {
  if (handLandmarker && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;

    const result = handLandmarker.detectForVideo(video, performance.now());

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let pointing = false;

    if (result.landmarks && result.landmarks.length > 0) {
      for (const hand of result.landmarks) {
        pointing = handleGestures(hand) || pointing;
      }
    }

    if (!pointing) decayBladeTrail();

    updateFruits();
    checkSliceCollisions();
    updateFruitPieces();

    drawFruits();
    drawFruitPieces();
    drawBladeTrail();

    fruitSpawnTimer++;
    if (fruitSpawnTimer >= FRUIT_SPAWN_INTERVAL) {
      fruitSpawnTimer = 0;
      spawnFruit();
    }
  }

  requestAnimationFrame(renderLoop);
}

// ---------- GESTURE DETECTION ----------

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

// NOTE: because the video is mirrored via CSS (scaleX(-1)) but the
// landmark coordinates come from the UN-mirrored camera frame, we
// flip the x coordinate here so the blade lines up with what you SEE
// on screen, not the raw camera data.
function handleGestures(landmarks) {
  const indexExtended = isFingerExtended(landmarks, FINGERS.index.tip, FINGERS.index.pip);
  const middleExtended = isFingerExtended(landmarks, FINGERS.middle.tip, FINGERS.middle.pip);
  const ringExtended = isFingerExtended(landmarks, FINGERS.ring.tip, FINGERS.ring.pip);
  const pinkyExtended = isFingerExtended(landmarks, FINGERS.pinky.tip, FINGERS.pinky.pip);

  const extendedCount = [indexExtended, middleExtended, ringExtended, pinkyExtended]
    .filter(Boolean).length;

  if (indexExtended && extendedCount === 1) {
    const indexTip = landmarks[8];
    // No manual flip here — the canvas element is already mirrored
    // via CSS (transform: scaleX(-1) in style.css), so drawing at the
    // raw landmark position lines up correctly once that CSS mirror
    // is applied. Flipping it again here would cancel that out.
    const px = indexTip.x * canvas.width;
    const py = indexTip.y * canvas.height;
    pushBladePoint(px, py);
    return true;
  }

  return false;
}

// ---------- BLADE TRAIL (Fruit-Ninja ribbon style) ----------

function pushBladePoint(x, y) {
  bladeTrail.push({ x, y, life: 1.0 });
  if (bladeTrail.length > MAX_TRAIL_LENGTH) bladeTrail.shift();
}

function decayBladeTrail() {
  for (const p of bladeTrail) p.life -= 0.12;
  bladeTrail = bladeTrail.filter((p) => p.life > 0);
}

// Draws the blade as a single tapering, glowing white ribbon —
// built from a filled polygon (perpendicular offsets along the path)
// rather than overlapping strokes, which is what gives Fruit Ninja's
// blade its sharp, solid-edged look instead of a fuzzy line.
function drawBladeTrail() {
  if (bladeTrail.length < 3) return;

  ctx.save();
  ctx.shadowColor = "#e0f2fe";
  ctx.shadowBlur = 20;

  const n = bladeTrail.length;
  const leftEdge = [];
  const rightEdge = [];

  for (let i = 0; i < n; i++) {
    const p = bladeTrail[i];
    const progress = i / (n - 1); // 0 (oldest/tail) -> 1 (newest/tip)
    const width = progress * 9;

    // Direction of travel at this point, to offset perpendicular to it
    const next = bladeTrail[Math.min(i + 1, n - 1)];
    const prev = bladeTrail[Math.max(i - 1, 0)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len; // perpendicular x
    const ny = dx / len; // perpendicular y

    leftEdge.push({ x: p.x + nx * width, y: p.y + ny * width });
    rightEdge.push({ x: p.x - nx * width, y: p.y - ny * width });
  }

  ctx.beginPath();
  ctx.moveTo(leftEdge[0].x, leftEdge[0].y);
  for (const pt of leftEdge) ctx.lineTo(pt.x, pt.y);
  for (let i = rightEdge.length - 1; i >= 0; i--) ctx.lineTo(rightEdge[i].x, rightEdge[i].y);
  ctx.closePath();

  const tailAlpha = bladeTrail[0].life;
  ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * tailAlpha})`;
  ctx.fill();

  ctx.restore();
}

// ---------- FRUITS ----------

// Every 50 points, fruits fall a bit faster. This reads the score
// only at spawn time, so fruits already in the air don't suddenly
// speed up mid-fall — only new ones do, which feels fairer.
const SPEED_INCREASE_PER_LEVEL = 0.5; // +0.5x speed per 50-point level
const POINTS_PER_LEVEL = 50;

function getDifficultyMultiplier() {
  const level = Math.floor(score / POINTS_PER_LEVEL);
  return 1 + level * SPEED_INCREASE_PER_LEVEL;
}

function spawnFruit() {
  const type = FRUIT_TYPES[Math.floor(Math.random() * FRUIT_TYPES.length)];
  const x = 80 + Math.random() * (canvas.width - 160);
  const speedMultiplier = getDifficultyMultiplier();

  fruits.push({
    x,
    y: -40,
    vx: (Math.random() - 0.5) * 2,
    vy: (3 + Math.random() * 1.5) * speedMultiplier,
    gravity: 0.09 * speedMultiplier,
    radius: 34 + Math.random() * 12,
    rotation: 0,
    rotationSpeed: (Math.random() - 0.5) * 0.1,
    color: type.color,
    innerColor: type.innerColor,
    sliced: false,
  });
}

function updateFruits() {
  for (const f of fruits) {
    f.vy += f.gravity;
    f.x += f.vx;
    f.y += f.vy;
    f.rotation += f.rotationSpeed;
  }
  // Remove fruits that fall off the bottom of the screen (missed —
  // no penalty for now, keeps the game low-pressure for a v1)
  fruits = fruits.filter((f) => f.y - f.radius < canvas.height + 60);
}

function drawFruits() {
  for (const f of fruits) {
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.rotation);

    ctx.fillStyle = f.color;
    ctx.beginPath();
    ctx.arc(0, 0, f.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = f.innerColor;
    ctx.beginPath();
    ctx.arc(0, -f.radius * 0.3, f.radius * 0.35, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

// ---------- SLICING (collision between blade trail and fruits) ----------

function checkSliceCollisions() {
  if (bladeTrail.length < 2) return;

  for (const f of fruits) {
    if (f.sliced) continue;

    for (let i = 1; i < bladeTrail.length; i++) {
      const a = bladeTrail[i - 1];
      const b = bladeTrail[i];

      if (pointSegmentDistance(f.x, f.y, a.x, a.y, b.x, b.y) < f.radius) {
        sliceFruit(f);
        break;
      }
    }
  }

  fruits = fruits.filter((f) => !f.sliced);
}

// Standard "distance from a point to a line segment" formula —
// used here to check if the blade path passed close enough to a
// fruit's center to count as a hit.
function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  return Math.hypot(px - closestX, py - closestY);
}

function sliceFruit(f) {
  f.sliced = true;
  addScore(10);

  // Split into two halves that fly apart — purely visual feedback
  for (const dir of [-1, 1]) {
    fruitPieces.push({
      x: f.x,
      y: f.y,
      vx: dir * (2 + Math.random() * 2),
      vy: -3 - Math.random() * 2,
      gravity: 0.15,
      radius: f.radius * 0.7,
      rotation: f.rotation,
      rotationSpeed: dir * 0.15,
      color: f.color,
      life: 1.0,
    });
  }
}

function updateFruitPieces() {
  for (const p of fruitPieces) {
    p.vy += p.gravity;
    p.x += p.vx;
    p.y += p.vy;
    p.rotation += p.rotationSpeed;
    p.life -= 0.015;
  }
  fruitPieces = fruitPieces.filter((p) => p.life > 0);
}

function drawFruitPieces() {
  for (const p of fruitPieces) {
    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rotation);

    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(0, 0, p.radius, 0, Math.PI, true); // half-circle = sliced look
    ctx.fill();

    ctx.restore();
  }
}

// Kick everything off
initHandLandmarker().then(startCamera);
