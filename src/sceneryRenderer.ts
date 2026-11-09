import * as THREE from "three";
export type Motion = { speed: number; running: boolean; cycling: boolean };
export function createForest(
  canvas: HTMLCanvasElement,
  read: () => Motion,
  onFallback: () => void,
) {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "low-power",
    });
  } catch {
    onFallback();
    return fallback(canvas, read);
  }
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#b8d6c2");
  scene.fog = new THREE.Fog("#b8d6c2", 28, 110);
  const camera = new THREE.PerspectiveCamera(66, 1, 0.1, 140);
  camera.position.set(0, 1.65, 0);
  camera.lookAt(0, 1.6, -35);
  scene.add(new THREE.HemisphereLight("#eff5dc", "#536c44", 2.5));
  const groundGeometry = new THREE.PlaneGeometry(220, 260);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundMaterial = new THREE.MeshLambertMaterial({ color: "#7d9d65" });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.position.set(0, -0.04, -90);
  scene.add(ground);
  const pathGeometry = new THREE.PlaneGeometry(3.6, 260);
  pathGeometry.rotateX(-Math.PI / 2);
  const pathMaterial = new THREE.MeshLambertMaterial({ color: "#b6b095" });
  const path = new THREE.Mesh(pathGeometry, pathMaterial);
  path.position.set(0, 0, -90);
  scene.add(path);
  const trunkGeometry = new THREE.CylinderGeometry(0.14, 0.23, 3, 5),
    leafGeometry = new THREE.ConeGeometry(1.8, 5.4, 6),
    rockGeometry = new THREE.DodecahedronGeometry(0.6, 0);
  const trunkMaterial = new THREE.MeshLambertMaterial({ color: "#76644a" }),
    leafMaterial = new THREE.MeshLambertMaterial({ color: "#3d7654" }),
    rockMaterial = new THREE.MeshLambertMaterial({ color: "#a3ad95" });
  const count = 100,
    trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, count),
    leaves = new THREE.InstancedMesh(leafGeometry, leafMaterial, count),
    rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, 40);
  scene.add(trunks, leaves, rocks);
  const matrix = new THREE.Object3D();
  let distance = 0,
    speed = 0,
    last = 0,
    raf = 0,
    disposed = false,
    frames = 0,
    slow = 0;
  let ratio = Math.min(devicePixelRatio || 1, 1.5);
  const resize = () => {
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  function draw(now: number) {
    if (disposed) return;
    raf = requestAnimationFrame(draw);
    if (document.hidden) {
      last = now;
      return;
    }
    if (now - last < 32) return;
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    const motion = read();
    const target = motion.running
      ? Math.min(18, Math.max(0, motion.speed / 3.6))
      : 0;
    speed = motion.running
      ? speed + (target - speed) * (1 - Math.exp(-dt * 3))
      : 0;
    distance += speed * dt;
    pathMaterial.color.set(motion.cycling ? "#727e72" : "#b6b095");
    for (let i = 0; i < count; i++) {
      const side = i % 2 ? 1 : -1;
      const z = (-(((i * 7.13 - distance) % 125) + 125) % 125) + 8;
      const x = side * (4 + random(i + 1) * 22);
      const scale = 0.65 + random(i + 20) * 0.9;
      matrix.position.set(x, 1.5 * scale, z);
      matrix.scale.setScalar(scale);
      matrix.rotation.set(0, random(i + 32) * 6, 0);
      matrix.updateMatrix();
      trunks.setMatrixAt(i, matrix.matrix);
      matrix.position.y = 4.8 * scale;
      matrix.updateMatrix();
      leaves.setMatrixAt(i, matrix.matrix);
      leaves.setColorAt(
        i,
        new THREE.Color().setHSL(
          0.35 + random(i + 70) * 0.07,
          0.24,
          0.25 + random(i + 120) * 0.13,
        ),
      );
    }
    for (let i = 0; i < 40; i++) {
      matrix.position.set(
        (i % 2 ? 1 : -1) * (2.2 + random(i + 90) * 2),
        0.2,
        (-(((i * 9.71 - distance) % 125) + 125) % 125) + 8,
      );
      matrix.scale.setScalar(0.35 + random(i + 150));
      matrix.rotation.set(0, i, 0);
      matrix.updateMatrix();
      rocks.setMatrixAt(i, matrix.matrix);
    }
    trunks.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    rocks.instanceMatrix.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    // Stable eye-height camera. Very gentle lateral turns, with no head bobbing.
    camera.position.x = Math.sin(distance / 95) * 0.18;
    camera.lookAt(Math.sin(distance / 95) * 0.3, 1.6, -35);
    const start = performance.now();
    renderer.render(scene, camera);
    if (++frames % 90 === 0 && performance.now() - start > 25 && ratio > 1) {
      ratio = 1;
      resize();
      slow++;
    }
  }
  raf = requestAnimationFrame(draw);
  let fallbackCleanup: (() => void) | undefined;
  const loss = (e: Event) => {
    e.preventDefault();
    disposed = true;
    cancelAnimationFrame(raf);
    onFallback();
    fallbackCleanup = fallback(canvas, read);
  };
  canvas.addEventListener("webglcontextlost", loss);
  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    fallbackCleanup?.();
    observer.disconnect();
    canvas.removeEventListener("webglcontextlost", loss);
    trunks.dispose();
    leaves.dispose();
    rocks.dispose();
    [
      groundGeometry,
      pathGeometry,
      trunkGeometry,
      leafGeometry,
      rockGeometry,
    ].forEach((g) => g.dispose());
    [
      groundMaterial,
      pathMaterial,
      trunkMaterial,
      leafMaterial,
      rockMaterial,
    ].forEach((m) => m.dispose());
    renderer.dispose();
  };
}
function random(seed: number) {
  const n = Math.sin(seed * 127.1) * 43758.5453;
  return n - Math.floor(n);
}
function fallback(canvas: HTMLCanvasElement, read: () => Motion) {
  // A fresh canvas is needed when WebGL has already claimed the original context.
  const replacement = document.createElement("canvas");
  replacement.className = canvas.className;
  replacement.setAttribute("aria-label", "Simplified forest scenery");
  canvas.replaceWith(replacement);
  const ctx = replacement.getContext("2d");
  let raf = 0,
    last = 0,
    distance = 0;
  function draw(now: number) {
    raf = requestAnimationFrame(draw);
    if (document.hidden || now - last < 50) return;
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    const m = read();
    if (m.running) distance += Math.max(0, m.speed / 3.6) * dt;
    const w = replacement.clientWidth,
      h = replacement.clientHeight;
    if (replacement.width !== w || replacement.height !== h) {
      replacement.width = w;
      replacement.height = h;
    }
    if (!ctx) return;
    ctx.fillStyle = "#b8d6c2";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#7d9d65";
    ctx.fillRect(0, h * 0.48, w, h);
    ctx.fillStyle = m.cycling ? "#727e72" : "#b6b095";
    ctx.beginPath();
    ctx.moveTo(w * 0.48, h * 0.48);
    ctx.lineTo(w * 0.52, h * 0.48);
    ctx.lineTo(w * 0.85, h);
    ctx.lineTo(w * 0.15, h);
    ctx.fill();
    for (let i = 0; i < 32; i++) {
      const depth = ((((i * 7 - distance) % 110) + 110) % 110) + 2;
      const scale = 1 / (depth * 0.06 + 1);
      const y = h * 0.48 + h * 0.6 * scale,
        x = w / 2 + (i % 2 ? 1 : -1) * w * 0.85 * scale;
      ctx.fillStyle = "#76644a";
      ctx.fillRect(x - 3 * scale, y - 80 * scale, 6 * scale, 80 * scale);
      ctx.fillStyle = "#3d7654";
      ctx.beginPath();
      ctx.moveTo(x, y - 160 * scale);
      ctx.lineTo(x - 45 * scale, y - 40 * scale);
      ctx.lineTo(x + 45 * scale, y - 40 * scale);
      ctx.fill();
    }
  }
  raf = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(raf);
    replacement.replaceWith(canvas);
  };
}
