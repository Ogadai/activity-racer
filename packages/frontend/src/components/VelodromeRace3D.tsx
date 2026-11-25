import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import raceTrackUrl from '../assets/race-track.jpg';
import { createCyclistRig, type CyclistRig } from '../race/cyclistMesh';
import {
  DEFAULT_TRACK_CONFIG,
  TRACK_PLANE_HEIGHT,
  TRACK_PLANE_WIDTH,
  sampleRaceTimeline,
  type RaceTimeline,
  type RiderFrameState,
} from '../race/trackMath';
import {
  LabelIcon,
  LabelOffIcon,
  MyLocationIcon,
  StadiumIcon,
  TopDownIcon,
  TrophyIcon,
} from './Icons';
import type { PlaybackSpeed } from './PlaybackControls';

export type CameraMode = 'stadium' | 'top' | 'leader' | 'me';

interface VelodromeRace3DProps {
  timeline: RaceTimeline;
  timelineTRef: React.MutableRefObject<number>;
  isPlayingRef: React.MutableRefObject<boolean>;
  speedRef: React.MutableRefObject<PlaybackSpeed>;
  cameraMode: CameraMode;
  showLabels: boolean;
  hasCurrentUser: boolean;
  onCameraModeChange: (mode: CameraMode) => void;
  onToggleLabels: () => void;
}

interface LabelRefs {
  container: HTMLDivElement | null;
  score: HTMLSpanElement | null;
  overdrive: HTMLSpanElement | null;
  leader: HTMLSpanElement | null;
}

function checkWebGL2Support(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    return Boolean(gl);
  } catch {
    return false;
  }
}

export default function VelodromeRace3D({
  timeline,
  timelineTRef,
  isPlayingRef,
  speedRef,
  cameraMode,
  showLabels,
  hasCurrentUser,
  onCameraModeChange,
  onToggleLabels,
}: VelodromeRace3DProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [webglError, setWebglError] = useState<string | null>(() =>
    checkWebGL2Support() ? null : 'WebGL2 is unavailable in this browser or device.',
  );

  // Keep latest reactive props in refs for the 60fps rAF loop without recreating the WebGL context
  const timelineRef = useRef<RaceTimeline>(timeline);
  timelineRef.current = timeline;

  const cameraModeRef = useRef<CameraMode>(cameraMode);
  cameraModeRef.current = cameraMode;

  const showLabelsRef = useRef<boolean>(showLabels);
  showLabelsRef.current = showLabels;

  // Direct DOM refs for zero-overhead 60fps projected nameplates
  const labelRefsMap = useRef<Map<string, LabelRefs>>(new Map());
  const rigsRef = useRef<Map<string, CyclistRig>>(new Map());
  const ridersGroupRef = useRef<THREE.Group | null>(null);

  // Stable list of riders for rendering HTML nameplate nodes
  const riderRoster = useMemo(
    () =>
      timeline.riders.map((r) => ({
        userId: r.standing.userId,
        displayName: r.standing.displayName,
        bikeColor: r.standing.bikeColor,
        isCurrentUser: r.standing.isCurrentUser,
      })),
    [timeline],
  );

  // Sync Three.js cyclist rigs whenever the rider roster or colors change
  useEffect(() => {
    const ridersGroup = ridersGroupRef.current;
    if (!ridersGroup) {
      return;
    }

    const activeIds = new Set(timeline.riders.map((r) => r.standing.userId));

    // Remove riders no longer in the race
    for (const [id, rig] of rigsRef.current.entries()) {
      if (!activeIds.has(id)) {
        ridersGroup.remove(rig.root);
        rig.dispose();
        rigsRef.current.delete(id);
      }
    }

    // Add new riders or refresh bike colors
    for (const r of timeline.riders) {
      const existing = rigsRef.current.get(r.standing.userId);
      if (existing) {
        existing.setBikeColor(r.standing.bikeColor);
      } else {
        const rig = createCyclistRig(r.standing.userId, r.standing.bikeColor);
        rigsRef.current.set(r.standing.userId, rig);
        ridersGroup.add(rig.root);
      }
    }
  }, [timeline]);

  // Mount Three.js scene, textured velodrome ground plane, lighting, and rAF loop
  useEffect(() => {
    const stageEl = stageRef.current;
    if (!stageEl || webglError) {
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch {
      setWebglError('Unable to initialize the 3D WebGL2 renderer.');
      return;
    }

    if (!renderer.capabilities.isWebGL2) {
      renderer.dispose();
      setWebglError('WebGL2 context could not be created.');
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'velodrome-canvas';
    renderer.domElement.setAttribute('aria-label', '3D Velodrome Bike Race');

    stageEl.innerHTML = '';
    stageEl.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0f1620');

    const camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 140);

    // --- Stadium Lighting ---
    const hemiLight = new THREE.HemisphereLight('#f0f7ff', '#3b2b1d', 0.95);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight('#fff7eb', 1.55);
    keyLight.position.set(5.5, 13.5, 7.5);
    keyLight.castShadow = true;
    const shadowSize = window.innerWidth < 640 ? 1024 : 2048;
    keyLight.shadow.mapSize.set(shadowSize, shadowSize);
    keyLight.shadow.camera.near = 2;
    keyLight.shadow.camera.far = 34;
    keyLight.shadow.camera.left = -9.5;
    keyLight.shadow.camera.right = 9.5;
    keyLight.shadow.camera.top = 6.5;
    keyLight.shadow.camera.bottom = -6.5;
    keyLight.shadow.bias = -0.0005;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight('#93c5fd', 0.55);
    rimLight.position.set(-7.5, 8.0, -6.5);
    scene.add(rimLight);

    // --- Textured 3D Velodrome Ground Plane ---
    const textureLoader = new THREE.TextureLoader();
    const trackTexture = textureLoader.load(raceTrackUrl);
    trackTexture.colorSpace = THREE.SRGBColorSpace;
    trackTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    const groundGeo = new THREE.PlaneGeometry(TRACK_PLANE_WIDTH, TRACK_PLANE_HEIGHT);
    const groundMat = new THREE.MeshStandardMaterial({
      map: trackTexture,
      roughness: 0.76,
      metalness: 0.04,
    });
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.y = 0;
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);

    // Subtle dark apron extending beyond image plane so zoomed/tilted angles never show harsh edges
    const apronGeo = new THREE.PlaneGeometry(TRACK_PLANE_WIDTH * 2.8, TRACK_PLANE_HEIGHT * 2.8);
    const apronMat = new THREE.MeshStandardMaterial({
      color: '#0e141d',
      roughness: 0.95,
      metalness: 0,
    });
    const apronMesh = new THREE.Mesh(apronGeo, apronMat);
    apronMesh.rotation.x = -Math.PI / 2;
    apronMesh.position.y = -0.015;
    scene.add(apronMesh);

    // Group holding all cyclist rigs
    const ridersGroup = new THREE.Group();
    ridersGroupRef.current = ridersGroup;
    scene.add(ridersGroup);

    // Populate initial cyclist rigs immediately
    for (const r of timelineRef.current.riders) {
      const rig = createCyclistRig(r.standing.userId, r.standing.bikeColor);
      rigsRef.current.set(r.standing.userId, rig);
      ridersGroup.add(rig.root);
    }

    // Viewport resize management
    let viewWidth = Math.max(1, stageEl.clientWidth);
    let viewHeight = Math.max(1, stageEl.clientHeight);
    const updateSize = () => {
      if (!stageEl) return;
      viewWidth = Math.max(1, stageEl.clientWidth);
      viewHeight = Math.max(1, stageEl.clientHeight);
      camera.aspect = viewWidth / viewHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(viewWidth, viewHeight, false);
    };
    updateSize();

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(stageEl);

    // Camera animation vectors (reused every frame)
    const desiredCamPos = new THREE.Vector3(0, 10.4, 11.4);
    const desiredLookAt = new THREE.Vector3(0, 0, 0.25);
    const currentCamPos = desiredCamPos.clone();
    const currentLookAt = desiredLookAt.clone();
    const projVec = new THREE.Vector3();
    let initializedCamera = false;

    const computeChaseTarget = (rider: RiderFrameState, distScale: number) => {
      const rx = rider.pose.x - DEFAULT_TRACK_CONFIG.centerX;
      const rz = rider.pose.z - DEFAULT_TRACK_CONFIG.centerZ;
      const rLen = Math.max(0.01, Math.hypot(rx, rz));
      const outX = rx / rLen;
      const outZ = rz / rLen;

      const scale = Math.min(1.25, distScale);
      desiredCamPos.set(
        rider.pose.x - rider.pose.tangentX * 2.3 * scale + outX * 2.9 * scale,
        3.6 * scale,
        rider.pose.z - rider.pose.tangentZ * 2.3 * scale + outZ * 2.9 * scale,
      );
      desiredLookAt.set(
        rider.pose.x + rider.pose.tangentX * 0.55,
        0.38,
        rider.pose.z + rider.pose.tangentZ * 0.55,
      );
    };

    let rafId: number | null = null;
    let lastFrameMs = performance.now();
    let elapsedSec = 0;

    const renderFrame = (nowMs: number) => {
      rafId = null;
      if (document.visibilityState === 'hidden') {
        return;
      }

      const dtSec = Math.min(0.1, Math.max(0, (nowMs - lastFrameMs) / 1000));
      lastFrameMs = nowMs;
      elapsedSec += dtSec;

      const tl = timelineRef.current;
      const frame = sampleRaceTimeline(tl, timelineTRef.current);
      const isPlaying = isPlayingRef.current;
      const speed = speedRef.current;

      // Update every cyclist rig on the track
      for (const rider of frame.riders) {
        const rig = rigsRef.current.get(rider.userId);
        if (!rig) continue;
        rig.update({
          pose: rider.pose,
          lapsPerSecond: rider.lapsPerSecond,
          playbackSpeed: speed,
          isPlaying,
          dtSec,
          elapsedSec,
          isLiveLeader: rider.isLiveLeader,
          isOverdrive: rider.isOverdrive,
          isCurrentUser: rider.standing.isCurrentUser,
        });
      }

      // Compute target camera pose based on selected broadcast mode
      const aspect = viewWidth / Math.max(1, viewHeight);
      const distScale = Math.max(1, 1.62 / Math.max(0.65, aspect));
      const mode = cameraModeRef.current;

      if (mode === 'top') {
        desiredCamPos.set(0, 16.4 * distScale, 0.02);
        desiredLookAt.set(0, 0, 0);
      } else if (mode === 'leader' && frame.liveStandings.length > 0) {
        computeChaseTarget(frame.liveStandings[0], distScale);
      } else if (mode === 'me') {
        const me =
          frame.riders.find((r) => r.standing.isCurrentUser) ?? frame.liveStandings[0];
        if (me) {
          computeChaseTarget(me, distScale);
        }
      } else {
        // Default 3D Stadium broadcast (~42 deg elevation)
        desiredCamPos.set(0, 10.3 * distScale, 11.4 * distScale);
        desiredLookAt.set(0, 0, 0.25);
      }

      if (!initializedCamera) {
        currentCamPos.copy(desiredCamPos);
        currentLookAt.copy(desiredLookAt);
        initializedCamera = true;
      } else {
        const damp = 1 - Math.exp(-5.5 * dtSec);
        currentCamPos.lerp(desiredCamPos, damp);
        currentLookAt.lerp(desiredLookAt, damp);
      }

      camera.position.copy(currentCamPos);
      camera.lookAt(currentLookAt);
      camera.updateMatrixWorld();

      renderer.render(scene, camera);

      // Project crisp HTML/CSS rider nameplates directly onto overlay DOM refs
      const labelsVisible = showLabelsRef.current;
      for (const rider of frame.riders) {
        const refs = labelRefsMap.current.get(rider.userId);
        const rig = rigsRef.current.get(rider.userId);
        if (!refs?.container || !rig) continue;

        if (!labelsVisible) {
          refs.container.style.opacity = '0';
          continue;
        }

        rig.getLabelAnchorWorldPosition(projVec);
        projVec.project(camera);

        if (projVec.z > 1 || projVec.z < -1) {
          refs.container.style.opacity = '0';
          continue;
        }

        const rawX = (projVec.x * 0.5 + 0.5) * viewWidth;
        const rawY = (-projVec.y * 0.5 + 0.5) * viewHeight;

        // Soft margin clamp so edge riders keep readable nameplates
        const px = Math.max(54, Math.min(viewWidth - 54, rawX));
        const py = Math.max(36, Math.min(viewHeight - 10, rawY));

        refs.container.style.opacity = '1';
        refs.container.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0) translate(-50%, -100%)`;
        refs.container.style.zIndex = String(
          Math.max(1, Math.min(500, Math.round((1 - projVec.z) * 500))),
        );

        if (refs.score) {
          const text =
            tl.range === 'weekly'
              ? `${rider.laps.toFixed(2)}L · ${rider.livePct.toFixed(0)}%`
              : `${rider.livePct.toFixed(1)}%`;
          if (refs.score.textContent !== text) {
            refs.score.textContent = text;
          }
        }
        if (refs.overdrive) {
          refs.overdrive.hidden = !rider.isOverdrive;
        }
        if (refs.leader) {
          refs.leader.hidden = !rider.isLiveLeader;
        }
      }

      rafId = window.requestAnimationFrame(renderFrame);
    };

    const startLoop = () => {
      if (rafId === null && document.visibilityState !== 'hidden') {
        lastFrameMs = performance.now();
        rafId = window.requestAnimationFrame(renderFrame);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
      } else {
        startLoop();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    startLoop();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      resizeObserver.disconnect();
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      for (const rig of rigsRef.current.values()) {
        ridersGroup.remove(rig.root);
        rig.dispose();
      }
      rigsRef.current.clear();
      ridersGroupRef.current = null;

      trackTexture.dispose();
      groundGeo.dispose();
      groundMat.dispose();
      apronGeo.dispose();
      apronMat.dispose();
      renderer.dispose();
      stageEl.innerHTML = '';
    };
  }, [webglError, timelineTRef, isPlayingRef, speedRef]);

  if (webglError) {
    return (
      <div className="velodrome-fallback">
        <div className="alert alert-info">
          <strong>3D Velodrome unavailable:</strong> {webglError} The timeline HUD and full
          interactive standings table below remain available.
        </div>
      </div>
    );
  }

  return (
    <div className="velodrome-shell">
      <div className="velodrome-toolbar">
        <div className="segmented cam-segmented" role="group" aria-label="Camera perspective">
          <button
            type="button"
            className={cameraMode === 'stadium' ? 'seg-btn cam-btn active' : 'seg-btn cam-btn'}
            onClick={() => onCameraModeChange('stadium')}
            title="3D Stadium view"
            aria-label="3D Stadium view"
          >
            <StadiumIcon size={15} />
            <span className="cam-btn-label">3D</span>
          </button>
          <button
            type="button"
            className={cameraMode === 'top' ? 'seg-btn cam-btn active' : 'seg-btn cam-btn'}
            onClick={() => onCameraModeChange('top')}
            title="Top-Down view"
            aria-label="Top-Down view"
          >
            <TopDownIcon size={15} />
            <span className="cam-btn-label">Top</span>
          </button>
          <button
            type="button"
            className={cameraMode === 'leader' ? 'seg-btn cam-btn active' : 'seg-btn cam-btn'}
            onClick={() => onCameraModeChange('leader')}
            title="Follow Leader"
            aria-label="Follow Leader"
          >
            <TrophyIcon size={15} />
            <span className="cam-btn-label">Leader</span>
          </button>
          {hasCurrentUser && (
            <button
              type="button"
              className={cameraMode === 'me' ? 'seg-btn cam-btn active' : 'seg-btn cam-btn'}
              onClick={() => onCameraModeChange('me')}
              title="Follow Me"
              aria-label="Follow Me"
            >
              <MyLocationIcon size={15} />
              <span className="cam-btn-label">Me</span>
            </button>
          )}
        </div>

        <button
          type="button"
          className={showLabels ? 'btn btn-secondary btn-xs label-toggle-btn active' : 'btn btn-secondary btn-xs label-toggle-btn'}
          onClick={onToggleLabels}
          aria-pressed={showLabels}
          aria-label={showLabels ? 'Hide rider labels' : 'Show rider labels'}
          title={showLabels ? 'Hide Labels' : 'Show Labels'}
        >
          {showLabels ? <LabelIcon size={15} /> : <LabelOffIcon size={15} />}
          <span className="label-toggle-text">{showLabels ? 'Labels' : 'Hidden'}</span>
        </button>
      </div>

      <div className="velodrome-viewport">
        <div ref={stageRef} className="velodrome-stage" />

        <div className="velodrome-overlay" aria-hidden="true">
          {riderRoster.map((rider) => (
            <div
              key={rider.userId}
              className={`rider-nameplate${rider.isCurrentUser ? ' is-self' : ''}`}
              ref={(el) => {
                const existing = labelRefsMap.current.get(rider.userId) ?? {
                  container: null,
                  score: null,
                  overdrive: null,
                  leader: null,
                };
                existing.container = el;
                labelRefsMap.current.set(rider.userId, existing);
              }}
            >
              <div className="nameplate-row">
                <span
                  className="nameplate-leader"
                  hidden
                  ref={(el) => {
                    const existing = labelRefsMap.current.get(rider.userId);
                    if (existing) existing.leader = el;
                  }}
                >
                  ★
                </span>
                <span
                  className="color-dot"
                  style={{ backgroundColor: rider.bikeColor }}
                />
                <span className="nameplate-name">{rider.displayName}</span>
                {rider.isCurrentUser && <span className="nameplate-pill self">You</span>}
              </div>
              <div className="nameplate-meta">
                <span
                  className="nameplate-score"
                  ref={(el) => {
                    const existing = labelRefsMap.current.get(rider.userId);
                    if (existing) existing.score = el;
                  }}
                >
                  0%
                </span>
                <span
                  className="nameplate-pill overdrive"
                  hidden
                  ref={(el) => {
                    const existing = labelRefsMap.current.get(rider.userId);
                    if (existing) existing.overdrive = el;
                  }}
                >
                  OVERDRIVE
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
