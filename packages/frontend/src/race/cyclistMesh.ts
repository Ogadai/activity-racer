import * as THREE from 'three';
import type { TrackPose } from './trackMath';

export interface CyclistUpdateParams {
  pose: TrackPose;
  /** Instantaneous track speed in laps per second at 1x */
  lapsPerSecond: number;
  /** Current playback speed multiplier (0.5, 1, 2, 4) */
  playbackSpeed: number;
  /** Whether playback is actively running */
  isPlaying: boolean;
  /** Frame delta time in seconds */
  dtSec: number;
  /** Monotonic elapsed time in seconds for ambient halo/aura animations */
  elapsedSec: number;
  isLiveLeader: boolean;
  isOverdrive: boolean;
  isCurrentUser: boolean;
}

export interface CyclistRig {
  userId: string;
  root: THREE.Group;
  update: (params: CyclistUpdateParams) => void;
  setBikeColor: (hexColor: string) => void;
  getLabelAnchorWorldPosition: (out: THREE.Vector3) => THREE.Vector3;
  dispose: () => void;
}

const WHEEL_RADIUS = 0.155;
const CRANK_CENTER_Y = 0.165;
const CRANK_CENTER_Z = -0.02;
const CRANK_RADIUS = 0.068;
const HIP_Y = 0.42;
const HIP_Z = -0.105;
const THIGH_LEN = 0.195;
const SHIN_LEN = 0.195;
const UP_AXIS = new THREE.Vector3(0, 1, 0);

function createTubeMesh(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  radialSegments = 6,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(end, start);
  const len = Math.max(0.001, dir.length());
  const geo = new THREE.CylinderGeometry(radius, radius, len, radialSegments);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP_AXIS, dir.normalize());
  mesh.castShadow = true;
  return mesh;
}

function positionLimbBetween(
  mesh: THREE.Mesh,
  start: THREE.Vector3,
  end: THREE.Vector3,
  tempDir: THREE.Vector3,
): void {
  tempDir.subVectors(end, start);
  const len = Math.max(0.001, tempDir.length());
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.scale.set(1, len, 1);
  mesh.quaternion.setFromUnitVectors(UP_AXIS, tempDir.divideScalar(len));
}

function buildWheel(
  tireMat: THREE.Material,
  rimMat: THREE.Material,
  spokeMat: THREE.Material,
): THREE.Group {
  const wheelGroup = new THREE.Group();

  // Tire oriented in YZ plane (axle along X)
  const tire = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_RADIUS, 0.021, 8, 22), tireMat);
  tire.rotation.y = Math.PI / 2;
  tire.castShadow = true;
  wheelGroup.add(tire);

  // Inner metallic rim
  const rim = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_RADIUS - 0.022, 0.009, 6, 20), rimMat);
  rim.rotation.y = Math.PI / 2;
  wheelGroup.add(rim);

  // Hub
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.05, 8), rimMat);
  hub.rotation.z = Math.PI / 2;
  wheelGroup.add(hub);

  // 3 visible spokes (6 radii) so wheel spin is unmistakable
  const spokeGeo = new THREE.CylinderGeometry(0.005, 0.005, (WHEEL_RADIUS - 0.024) * 2, 4);
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.Mesh(spokeGeo, spokeMat);
    spoke.rotation.x = (i * Math.PI) / 3;
    wheelGroup.add(spoke);
  }

  return wheelGroup;
}

/**
 * Creates a lightweight procedural low-poly track cyclist + velodrome bike.
 * Local coordinate system: +Z is forward, +Y is up, +X is rider's left (inward
 * toward velodrome center when riding counter-clockwise).
 */
export function createCyclistRig(userId: string, initialColor: string): CyclistRig {
  const root = new THREE.Group();
  root.name = `cyclist-${userId}`;

  // Child group pivoted at tire contact line (y = 0) so banking lean tilts cleanly inward
  const leanGroup = new THREE.Group();
  root.add(leanGroup);

  const primaryColor = new THREE.Color(initialColor || '#2563eb');
  const accentColor = primaryColor.clone().lerp(new THREE.Color('#ffffff'), 0.28);

  const frameMat = new THREE.MeshStandardMaterial({
    color: primaryColor,
    metalness: 0.45,
    roughness: 0.32,
  });
  const jerseyMat = new THREE.MeshStandardMaterial({
    color: primaryColor,
    metalness: 0.08,
    roughness: 0.62,
  });
  const helmetMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    metalness: 0.25,
    roughness: 0.28,
  });
  const carbonMat = new THREE.MeshStandardMaterial({
    color: '#18202c',
    metalness: 0.25,
    roughness: 0.55,
  });
  const tireMat = new THREE.MeshStandardMaterial({
    color: '#11161d',
    metalness: 0.05,
    roughness: 0.85,
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: '#cbd5e1',
    metalness: 0.7,
    roughness: 0.25,
  });
  const spokeMat = new THREE.MeshStandardMaterial({
    color: '#e2e8f0',
    metalness: 0.6,
    roughness: 0.3,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    color: '#eab896',
    metalness: 0.02,
    roughness: 0.75,
  });
  const bibMat = new THREE.MeshStandardMaterial({
    color: '#1c2430',
    metalness: 0.05,
    roughness: 0.8,
  });
  const stripeMat = new THREE.MeshStandardMaterial({
    color: '#f8fafc',
    metalness: 0.05,
    roughness: 0.5,
  });

  // --- Wheels ---
  const frontWheel = buildWheel(tireMat, rimMat, spokeMat);
  frontWheel.position.set(0, WHEEL_RADIUS, 0.265);
  leanGroup.add(frontWheel);

  const rearWheel = buildWheel(tireMat, rimMat, spokeMat);
  rearWheel.position.set(0, WHEEL_RADIUS, -0.265);
  leanGroup.add(rearWheel);

  // --- Diamond Bike Frame ---
  const bb = new THREE.Vector3(0, CRANK_CENTER_Y, CRANK_CENTER_Z);
  const seatCluster = new THREE.Vector3(0, 0.365, -0.105);
  const headTop = new THREE.Vector3(0, 0.385, 0.165);
  const headBottom = new THREE.Vector3(0, 0.315, 0.188);
  const rearAxleLeft = new THREE.Vector3(0.028, WHEEL_RADIUS, -0.265);
  const rearAxleRight = new THREE.Vector3(-0.028, WHEEL_RADIUS, -0.265);
  const frontAxleLeft = new THREE.Vector3(0.026, WHEEL_RADIUS, 0.265);
  const frontAxleRight = new THREE.Vector3(-0.026, WHEEL_RADIUS, 0.265);

  leanGroup.add(
    createTubeMesh(bb, headBottom, 0.014, frameMat), // Down tube
    createTubeMesh(seatCluster, headTop, 0.013, frameMat), // Top tube
    createTubeMesh(bb, seatCluster, 0.013, frameMat), // Seat tube
    createTubeMesh(headBottom, headTop, 0.015, frameMat), // Head tube
    createTubeMesh(seatCluster, rearAxleLeft, 0.009, frameMat), // Left seat stay
    createTubeMesh(seatCluster, rearAxleRight, 0.009, frameMat), // Right seat stay
    createTubeMesh(bb, rearAxleLeft, 0.01, frameMat), // Left chain stay
    createTubeMesh(bb, rearAxleRight, 0.01, frameMat), // Right chain stay
    createTubeMesh(headBottom, frontAxleLeft, 0.01, frameMat), // Left fork
    createTubeMesh(headBottom, frontAxleRight, 0.01, frameMat), // Right fork
  );

  // Chainring disc at bottom bracket
  const chainring = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.012, 12), rimMat);
  chainring.rotation.z = Math.PI / 2;
  chainring.position.set(-0.032, CRANK_CENTER_Y, CRANK_CENTER_Z);
  leanGroup.add(chainring);

  // Saddle & Seatpost
  leanGroup.add(
    createTubeMesh(seatCluster, new THREE.Vector3(0, 0.41, -0.115), 0.009, carbonMat),
  );
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.024, 0.125), carbonMat);
  saddle.position.set(0, 0.418, -0.11);
  saddle.castShadow = true;
  leanGroup.add(saddle);

  // Stem & Drop Handlebars
  const stemTip = new THREE.Vector3(0, 0.425, 0.215);
  leanGroup.add(createTubeMesh(headTop, stemTip, 0.01, carbonMat));
  const handlebar = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.24, 8), carbonMat);
  handlebar.rotation.z = Math.PI / 2;
  handlebar.position.copy(stemTip);
  leanGroup.add(handlebar);

  // Drop bar hooks
  for (const side of [-1, 1]) {
    const dropStart = new THREE.Vector3(side * 0.115, 0.425, 0.215);
    const dropEnd = new THREE.Vector3(side * 0.115, 0.37, 0.185);
    leanGroup.add(createTubeMesh(dropStart, dropEnd, 0.009, carbonMat));
  }

  // --- Rider Upper Body (aero tuck) ---
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.08, 0.11), bibMat);
  hips.position.set(0, 0.445, -0.105);
  hips.castShadow = true;
  leanGroup.add(hips);

  const torsoGroup = new THREE.Group();
  torsoGroup.position.set(0, 0.46, -0.09);
  torsoGroup.rotation.x = 0.86; // Aero forward lean toward bars
  leanGroup.add(torsoGroup);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.165, 0.25, 0.105), jerseyMat);
  torso.position.set(0, 0.125, 0);
  torso.castShadow = true;
  torsoGroup.add(torso);

  // Crisp jersey racing stripe for high visibility from top-down camera
  const backStripe = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.23, 0.112), stripeMat);
  backStripe.position.set(0, 0.125, 0);
  torsoGroup.add(backStripe);

  // Head + Aero Helmet positioned at shoulder/neck tip
  const headCenter = new THREE.Vector3(0, 0.655, 0.12);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.068, 10, 8), skinMat);
  head.position.copy(headCenter);
  head.castShadow = true;
  leanGroup.add(head);

  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.078, 12, 8), helmetMat);
  helmet.scale.set(0.95, 0.82, 1.32); // Sleek aero tail
  helmet.position.set(0, 0.685, 0.105);
  helmet.castShadow = true;
  leanGroup.add(helmet);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.028, 0.04), carbonMat);
  visor.position.set(0, 0.658, 0.175);
  leanGroup.add(visor);

  // Arms reaching from shoulders to handlebars
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Vector3(side * 0.095, 0.59, 0.06);
    const elbow = new THREE.Vector3(side * 0.11, 0.495, 0.135);
    const hand = new THREE.Vector3(side * 0.115, 0.425, 0.21);
    leanGroup.add(
      createTubeMesh(shoulder, elbow, 0.024, jerseyMat),
      createTubeMesh(elbow, hand, 0.02, skinMat),
    );
  }

  // --- Articulated Upper & Lower Legs (Unit-height cylinders driven by 2-bone IK) ---
  const thighGeo = new THREE.CylinderGeometry(0.032, 0.025, 1, 7);
  const shinGeo = new THREE.CylinderGeometry(0.024, 0.018, 1, 7);
  const shoeGeo = new THREE.BoxGeometry(0.042, 0.028, 0.078);

  const leftThigh = new THREE.Mesh(thighGeo, bibMat);
  const leftShin = new THREE.Mesh(shinGeo, skinMat);
  const leftShoe = new THREE.Mesh(shoeGeo, carbonMat);
  const rightThigh = new THREE.Mesh(thighGeo, bibMat);
  const rightShin = new THREE.Mesh(shinGeo, skinMat);
  const rightShoe = new THREE.Mesh(shoeGeo, carbonMat);

  for (const part of [leftThigh, leftShin, leftShoe, rightThigh, rightShin, rightShoe]) {
    part.castShadow = true;
    leanGroup.add(part);
  }

  // --- Leader Gold Halo / Crown Indicator ---
  const leaderHalo = new THREE.Group();
  leaderHalo.position.set(0, 0.84, 0.06);
  leaderHalo.visible = false;

  const haloMat = new THREE.MeshStandardMaterial({
    color: '#fbbf24',
    emissive: '#f59e0b',
    emissiveIntensity: 0.75,
    metalness: 0.7,
    roughness: 0.2,
  });
  const haloRing = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.015, 8, 20), haloMat);
  haloRing.rotation.x = Math.PI / 2;
  leaderHalo.add(haloRing);

  const crownPip = new THREE.Mesh(new THREE.OctahedronGeometry(0.042, 0), haloMat);
  crownPip.position.set(0, 0.055, 0);
  leaderHalo.add(crownPip);
  leanGroup.add(leaderHalo);

  // --- Overdrive Glowing Speed-Trail / Aura ---
  const overdriveGroup = new THREE.Group();
  overdriveGroup.visible = false;

  const overdriveMat = new THREE.MeshBasicMaterial({
    color: '#c084fc',
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const overdriveCoreMat = new THREE.MeshBasicMaterial({
    color: '#38bdf8',
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  // Swept speed ribbons behind the bike
  const trailOuter = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.72), overdriveMat);
  trailOuter.rotation.x = -Math.PI / 2;
  trailOuter.position.set(0, 0.06, -0.58);
  overdriveGroup.add(trailOuter);

  const trailInner = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.55), overdriveCoreMat);
  trailInner.rotation.x = -Math.PI / 2;
  trailInner.position.set(0, 0.08, -0.52);
  overdriveGroup.add(trailInner);

  // Speed aura ring behind rear wheel
  const auraRing = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.012, 6, 18), overdriveCoreMat);
  auraRing.position.set(0, 0.22, -0.35);
  overdriveGroup.add(auraRing);
  leanGroup.add(overdriveGroup);

  // --- Current-User Subtle Ground Ring (easy visual anchor) ---
  const selfRingMat = new THREE.MeshBasicMaterial({
    color: '#3ea2dd',
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const selfRing = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.37, 24), selfRingMat);
  selfRing.rotation.x = -Math.PI / 2;
  selfRing.position.set(0, 0.014, 0);
  selfRing.visible = false;
  root.add(selfRing);

  // Animation state & scratch vectors (zero allocations per frame)
  let crankPhase = 0;
  let wheelAngle = 0;
  const vHip = new THREE.Vector3();
  const vFoot = new THREE.Vector3();
  const vKnee = new THREE.Vector3();
  const vDir = new THREE.Vector3();

  function updateLeg(
    sideX: number,
    phase: number,
    thighMesh: THREE.Mesh,
    shinMesh: THREE.Mesh,
    shoeMesh: THREE.Mesh,
  ): void {
    const footY = CRANK_CENTER_Y + CRANK_RADIUS * Math.sin(phase);
    const footZ = CRANK_CENTER_Z + CRANK_RADIUS * Math.cos(phase);

    vHip.set(sideX, HIP_Y, HIP_Z);
    vFoot.set(sideX, footY, footZ);

    // 2D two-bone inverse kinematics in YZ plane, bending knee forward (+Z)
    const dy = footY - HIP_Y;
    const dz = footZ - HIP_Z;
    const dist = Math.max(0.05, Math.min(THIGH_LEN + SHIN_LEN - 0.01, Math.hypot(dy, dz)));

    const cosAngle =
      (THIGH_LEN * THIGH_LEN + dist * dist - SHIN_LEN * SHIN_LEN) / (2 * THIGH_LEN * dist);
    const clampedCos = Math.max(-1, Math.min(1, cosAngle));
    const offsetAngle = Math.acos(clampedCos);

    // Vector from hip to foot in (Z, Y) plane; bend knee toward +Z (forward)
    const baseAngle = Math.atan2(dy, dz);
    const kneeAngle = baseAngle + offsetAngle; // bends forward/upward into natural cycling posture

    const kneeZ = HIP_Z + THIGH_LEN * Math.cos(kneeAngle);
    const kneeY = HIP_Y + THIGH_LEN * Math.sin(kneeAngle);
    vKnee.set(sideX, kneeY, kneeZ);

    positionLimbBetween(thighMesh, vHip, vKnee, vDir);
    positionLimbBetween(shinMesh, vKnee, vFoot, vDir);
    shoeMesh.position.set(sideX, footY - 0.008, footZ + 0.018);
  }

  // Initialize resting leg pose
  updateLeg(0.06, 0, leftThigh, leftShin, leftShoe);
  updateLeg(-0.06, Math.PI, rightThigh, rightShin, rightShoe);

  const labelAnchorLocal = new THREE.Vector3(0, 0.94, 0.04);

  return {
    userId,
    root,
    setBikeColor(hexColor: string) {
      primaryColor.set(hexColor || '#2563eb');
      accentColor.copy(primaryColor).lerp(new THREE.Color('#ffffff'), 0.28);
      frameMat.color.copy(primaryColor);
      jerseyMat.color.copy(primaryColor);
      helmetMat.color.copy(accentColor);
    },
    update(params: CyclistUpdateParams) {
      const { pose, lapsPerSecond, playbackSpeed, isPlaying, dtSec, elapsedSec } = params;

      // Place on velodrome surface and align local +Z along analytical tangent
      root.position.set(pose.x, 0, pose.z);
      root.rotation.y = Math.atan2(pose.tangentX, pose.tangentZ);

      // Lean inward (+X is rider's left = velodrome center) around forward axis (+Z)
      leanGroup.rotation.z = -pose.bankAngleRad;

      // Wheel & leg cadence scale directly with instantaneous velocity
      const effectiveLapsPerSec = isPlaying ? Math.max(0, lapsPerSecond * playbackSpeed) : 0;
      if (effectiveLapsPerSec > 0.0005 && dtSec > 0) {
        const worldSpeed = effectiveLapsPerSec * pose.perimeter;
        wheelAngle += (worldSpeed / WHEEL_RADIUS) * dtSec;
        // Pedaling cadence (rad/s) smoothly proportional to speed
        const cadenceRadPerSec = Math.min(26, effectiveLapsPerSec * 18.5);
        crankPhase = (crankPhase + cadenceRadPerSec * dtSec) % (Math.PI * 2);
      }

      frontWheel.rotation.x = wheelAngle;
      rearWheel.rotation.x = wheelAngle;
      updateLeg(0.06, crankPhase, leftThigh, leftShin, leftShoe);
      updateLeg(-0.06, crankPhase + Math.PI, rightThigh, rightShin, rightShoe);

      // Leader golden crown / halo animation
      leaderHalo.visible = params.isLiveLeader;
      if (params.isLiveLeader) {
        leaderHalo.position.y = 0.85 + Math.sin(elapsedSec * 4.2) * 0.03;
        crownPip.rotation.y = elapsedSec * 2.4;
      }

      // Overdrive glowing speed trail & aura
      overdriveGroup.visible = params.isOverdrive;
      if (params.isOverdrive) {
        const pulse = 0.5 + 0.5 * Math.sin(elapsedSec * 10);
        overdriveMat.opacity = 0.36 + pulse * 0.3;
        overdriveCoreMat.opacity = 0.3 + (1 - pulse) * 0.32;
        const stretch = 0.92 + pulse * 0.24;
        trailOuter.scale.set(1, stretch, 1);
        auraRing.scale.setScalar(0.95 + pulse * 0.15);
      }

      // Current-user subtle ground ring
      selfRing.visible = params.isCurrentUser;
    },
    getLabelAnchorWorldPosition(out: THREE.Vector3): THREE.Vector3 {
      out.copy(labelAnchorLocal);
      leanGroup.localToWorld(out);
      return out;
    },
    dispose() {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      root.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          geometries.add(obj.geometry);
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => materials.add(m));
          } else {
            materials.add(obj.material);
          }
        }
      });
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}
