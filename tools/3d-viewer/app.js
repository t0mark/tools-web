/*
 * 3D 모델 뷰어 (three.js)
 *  - GLB/GLTF(+Draco/Meshopt/KTX2), OBJ(+MTL), STL, PLY, FBX, 3MF, DAE
 *  - 여러 파일을 함께 고르면 텍스처/.bin/.mtl 참조를 파일 이름으로 연결
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';

const LIBS = new URL('../../vendor/three/addons/libs/', import.meta.url).href;
const MODEL_EXTS = ['glb', 'gltf', 'fbx', 'obj', 'dae', '3mf', 'stl', 'ply'];
const FORMAT_NAMES = { glb: 'glTF Binary', gltf: 'glTF', obj: 'Wavefront OBJ', stl: 'STL', ply: 'PLY', fbx: 'FBX', '3mf': '3MF', dae: 'COLLADA' };

const $ = (id) => document.getElementById(id);
const els = {
  pick: $('pick-step'), view: $('view-step'), input: $('file-input'), dropzone: $('dropzone'),
  stage: $('stage'), loading: $('loading'), loadingText: $('loading-text'),
  reset: $('reset-view'), expand: $('expand'), zup: $('zup'),
  animBox: $('anim-box'), animSelect: $('anim-select'), info: $('info'),
  errorBox: $('error-box'), errorText: $('error-text'),
};

// ---------- 씬 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
els.stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
scene.add(camera);
// PBR이 아닌 재질(OBJ/FBX의 Phong 등)도 잘 보이도록 기본 조명
scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8d8d, 1.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(1, 2, 3);
camera.add(keyLight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotateSpeed = 2;

let grid = null;
let gridParams = null; // { size, divisions }
let lastFile = null; // { main, ext }
let model = null; // 현재 모델을 감싸는 그룹
let mixer = null;
let clips = [];
const timer = new THREE.Timer();
const opts = { wireframe: false, grid: true, autorotate: false, dark: false };
let home = null; // 초기 카메라 위치

function resize() {
  const w = els.stage.clientWidth;
  const h = els.stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(els.stage);

renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = timer.getDelta();
  if (mixer) mixer.update(dt);
  controls.update();
  renderer.render(scene, camera);
});

// ---------- 파일 → URL 매핑 ----------
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const baseOf = (path) => decodeURIComponent(path.split(/[\\/]/).pop().split('?')[0]).toLowerCase();
let blobUrls = [];

function makeManager(files) {
  const map = new Map();
  for (const f of files) {
    const url = URL.createObjectURL(f);
    blobUrls.push(url);
    map.set(f.name.toLowerCase(), url);
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    const hit = map.get(baseOf(url));
    return hit || url;
  });
  return { manager, map };
}

// ---------- 로더 ----------
async function loadModel(files) {
  const main = files
    .filter((f) => MODEL_EXTS.includes(extOf(f.name)))
    .sort((a, b) => MODEL_EXTS.indexOf(extOf(a.name)) - MODEL_EXTS.indexOf(extOf(b.name)))[0];
  if (!main) throw new Error('지원하는 3D 파일이 없습니다. (GLB, GLTF, OBJ, STL, PLY, FBX, 3MF, DAE)');

  const ext = extOf(main.name);
  const { manager, map } = makeManager(files);
  const url = map.get(main.name.toLowerCase());
  let object;
  let animations = [];

  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader(manager);
    const draco = new DRACOLoader(manager).setDecoderPath(`${LIBS}draco/gltf/`);
    const ktx2 = new KTX2Loader(manager).setTranscoderPath(`${LIBS}basis/`).detectSupport(renderer);
    loader.setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    object = gltf.scene || gltf.scenes[0];
    animations = gltf.animations || [];
  } else if (ext === 'obj') {
    const loader = new OBJLoader(manager);
    const mtl = files.find((f) => extOf(f.name) === 'mtl');
    if (mtl) {
      const materials = await new MTLLoader(manager).loadAsync(map.get(mtl.name.toLowerCase()));
      materials.preload();
      loader.setMaterials(materials);
    }
    object = await loader.loadAsync(url);
  } else if (ext === 'stl' || ext === 'ply') {
    const geometry = await (ext === 'stl' ? new STLLoader(manager) : new PLYLoader(manager)).loadAsync(url);
    const hasColor = !!geometry.attributes.color;
    const isPoints = ext === 'ply' && !geometry.index && !geometry.attributes.normal;
    if (isPoints) {
      object = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0, sizeAttenuation: false, vertexColors: hasColor, color: hasColor ? 0xffffff : 0x4466ff }));
    } else {
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: hasColor ? 0xffffff : 0x8f9bb3, vertexColors: hasColor, metalness: 0.1, roughness: 0.5, side: THREE.DoubleSide,
      }));
    }
  } else if (ext === 'fbx') {
    object = await new FBXLoader(manager).loadAsync(url);
    animations = object.animations || [];
  } else if (ext === '3mf') {
    object = await new ThreeMFLoader(manager).loadAsync(url);
  } else if (ext === 'dae') {
    const collada = await new ColladaLoader(manager).loadAsync(url);
    object = collada.scene;
    animations = collada.scene.animations || [];
  }
  return { object, animations, main, ext };
}

// ---------- 배치 / 카메라 ----------
function placeModel() {
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return box;
  const center = box.getCenter(new THREE.Vector3());
  // 가운데 정렬 + 바닥(y=0)에 올려놓기
  model.position.set(-center.x, -box.min.y, -center.z);
  model.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(model);
}

function fitCamera(box) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1e-6);
  // 세로 화면에서는 가로 시야각이 더 좁으므로 둘 중 작은 쪽 기준으로 맞춤
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.1;
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  const dir = new THREE.Vector3(1, 0.7, 1.3).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  controls.target.copy(center);
  controls.minDistance = radius * 0.05;
  controls.maxDistance = radius * 20;
  controls.update();
  home = { pos: camera.position.clone(), target: center.clone() };

  const span = Math.max(size.x, size.z) * 3 || 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / 2)));
  const divisions = Math.min(200, Math.max(10, Math.round(span / step)));
  gridParams = { size: step * divisions, divisions };
  buildGrid();
}

function buildGrid() {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); grid = null; }
  if (!gridParams) return;
  const [center, line] = opts.dark ? [0x5a6070, 0x2c313a] : [0x8890a0, 0xc4c9d2];
  grid = new THREE.GridHelper(gridParams.size, gridParams.divisions, center, line);
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  grid.visible = opts.grid;
  scene.add(grid);
}

function applyTheme() {
  els.stage.classList.toggle('dark', opts.dark);
  buildGrid();
}

// ---------- 정보 ----------
function fmt(n) { return n.toLocaleString('ko-KR'); }
function fmtLen(v) { return Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(3); }

function showInfo(main, ext, box) {
  let vertices = 0, triangles = 0, meshes = 0, points = 0;
  const materials = new Set();
  model.traverse((o) => {
    if (!o.geometry || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position.count;
    if (o.isMesh) {
      meshes++;
      vertices += pos;
      triangles += o.geometry.index ? o.geometry.index.count / 3 : pos / 3;
    } else if (o.isPoints) {
      points += pos;
    }
    [].concat(o.material || []).forEach((m) => materials.add(m));
  });
  const size = box.getSize(new THREE.Vector3());
  const rows = [
    ['파일', main.name],
    ['형식', `${FORMAT_NAMES[ext]} · ${main.size < 1024 * 1024 ? `${Math.max(1, Math.round(main.size / 1024))} KB` : `${(main.size / 1024 / 1024).toFixed(1)} MB`}`],
    meshes ? ['메시', fmt(meshes)] : null,
    vertices ? ['정점', fmt(vertices)] : null,
    triangles ? ['삼각형', fmt(Math.round(triangles))] : null,
    points ? ['점', fmt(points)] : null,
    ['재질', fmt(materials.size)],
    ['크기 (X×Y×Z)', `${fmtLen(size.x)} × ${fmtLen(size.y)} × ${fmtLen(size.z)}`],
    clips.length ? ['애니메이션', `${clips.length}개`] : null,
  ].filter(Boolean);
  els.info.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

// ---------- 열기 ----------
function disposeModel() {
  if (!model) return;
  scene.remove(model);
  model.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    [].concat(o.material || []).forEach((m) => {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    });
  });
  model = null;
  mixer = null;
  clips = [];
}

async function open(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  els.errorBox.classList.add('hidden');
  els.pick.classList.add('hidden');
  els.view.classList.remove('hidden');
  els.loading.classList.remove('hidden');
  els.loadingText.textContent = '불러오는 중…';
  resize();
  try {
    const { object, animations, main, ext } = await loadModel(files);
    disposeModel();
    model = new THREE.Group();
    model.add(object);
    scene.add(model);
    applyWireframe();

    clips = animations;
    els.animBox.classList.toggle('hidden', !clips.length);
    if (clips.length) {
      mixer = new THREE.AnimationMixer(object);
      els.animSelect.replaceChildren(
        new Option('정지', '-1'),
        ...clips.map((c, i) => new Option(c.name || `애니메이션 ${i + 1}`, String(i))),
      );
      els.animSelect.value = '0';
      playClip(0);
    }

    const box = placeModel();
    fitCamera(box);
    lastFile = { main, ext };
    showInfo(main, ext, box);
  } catch (err) {
    console.error(err);
    els.errorText.textContent = (err && err.message) || String(err);
    els.errorBox.classList.remove('hidden');
    if (!model) { els.view.classList.add('hidden'); els.pick.classList.remove('hidden'); }
  } finally {
    els.loading.classList.add('hidden');
    releaseBlobsLater();
  }
}

// 텍스처가 비동기로 늦게 로드될 수 있어 잠시 뒤에 해제
let releaseTimer = null;
function releaseBlobsLater() {
  clearTimeout(releaseTimer);
  const urls = blobUrls;
  blobUrls = [];
  releaseTimer = setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 30000);
}

function playClip(i) {
  if (!mixer) return;
  mixer.stopAllAction();
  if (i >= 0 && clips[i]) mixer.clipAction(clips[i]).play();
}

function applyWireframe() {
  if (!model) return;
  model.traverse((o) => [].concat(o.material || []).forEach((m) => { if ('wireframe' in m) m.wireframe = opts.wireframe; }));
}

// ---------- UI ----------
els.input.addEventListener('change', () => { open(els.input.files); els.input.value = ''; });
['dragenter', 'dragover'].forEach((t) => els.dropzone.addEventListener(t, (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((t) => els.dropzone.addEventListener(t, () => els.dropzone.classList.remove('dragover')));
els.dropzone.addEventListener('drop', (e) => { e.preventDefault(); open(e.dataTransfer.files); });

document.querySelectorAll('[data-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.toggle;
    opts[key] = !opts[key];
    btn.setAttribute('aria-pressed', String(opts[key]));
    if (key === 'wireframe') applyWireframe();
    if (key === 'grid' && grid) grid.visible = opts.grid;
    if (key === 'autorotate') controls.autoRotate = opts.autorotate;
    if (key === 'dark') applyTheme();
  });
});

els.zup.addEventListener('click', () => {
  if (!model) return;
  const inner = model.children[0];
  inner.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const box = placeModel();
  fitCamera(box);
  showInfo(lastFile.main, lastFile.ext, box);
});
els.reset.addEventListener('click', () => {
  if (!home) return;
  camera.position.copy(home.pos);
  controls.target.copy(home.target);
  controls.update();
});

els.expand.addEventListener('click', () => {
  els.stage.classList.toggle('expanded');
  document.body.style.overflow = els.stage.classList.contains('expanded') ? 'hidden' : '';
  resize();
});

els.animSelect.addEventListener('change', () => playClip(Number(els.animSelect.value)));
