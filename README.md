# Tools Web

모바일 우선 웹 도구 모음. 빌드 과정 없는 정적 사이트라서 GitHub Pages 등에 그대로 올리면 됩니다.
모든 처리는 브라우저 안에서 이루어지고, 파일이 서버로 전송되지 않습니다.

## 구조

```
index.html                 메인 화면 (도구 선택)
assets/css/base.css        공통 스타일 (라이트/다크 자동)
tools/<도구>/              도구별 페이지
vendor/                    외부 라이브러리 (직접 포함)
```

새 도구 추가: `tools/<이름>/index.html`을 만들고 `index.html`의 `.tool-list`에 카드를 하나 추가합니다.

배포: GitHub Pages (`main` 브랜치, `/ (root)`) → https://t0mark.github.io/tools-web/

## 도구

### MP4 → MP3 (`tools/mp4-to-mp3/`)

동영상의 오디오 트랙을 실제 MP3(MPEG-1 Layer III, CBR, 원본 샘플레이트 유지 — 보통 48/44.1kHz)로 다시 인코딩합니다. 확장자만 바꾸는 방식이 아닙니다.

1. MP4/MOV의 목차(moov)만 읽어 AAC 오디오 프레임만 골라 읽음 → 1GB 넘는 영상도 파일 전체를 메모리에 올리지 않음
2. 30초 구간씩 브라우저 내장 디코더(`decodeAudioData`)로 디코딩 (구간 경계는 겹침 처리로 끊김 없음)
3. Web Worker에서 [lamejs](https://github.com/zhuker/lamejs)(LAME의 JS 포팅, LGPL)로 MP3 인코딩
4. 비트레이트 64/128/192/320kbps, 스테레오/모노 선택 → 예상 용량 미리 표시
5. 다운로드, 또는 모바일에서 공유 시트로 저장/전송

5.1ch 등 다채널 오디오는 자동으로 스테레오/모노로 다운믹스됩니다.
AAC가 아닌 오디오나 fragmented MP4 등은 파일 전체를 한 번에 디코딩하는 방식으로 처리하므로, 이 경우 아주 큰 파일은 메모리 부족으로 실패할 수 있습니다.

### 이미지 푸리에 변환 (`tools/fft-image/`)

이미지를 256×256 또는 512×512로 리샘플링해 2D FFT(직접 구현, `fft.js`)를 계산합니다.

- 주파수 스펙트럼(로그 크기, 중앙 정렬) 표시
- 필터: 저역통과 / 고역통과 / 대역통과 / 대역저지 (이상적·가우시안·버터워스), 또는 스펙트럼 위에 **직접 칠해서** 차단 (원점 대칭 자동)
- 필터 적용 후 역 FFT 결과를 바로 표시하고 PNG로 저장
- 흑백 또는 RGB 채널별 처리. 표시할 때 원본 비율로 복원

### 3D 모델 뷰어 (`tools/3d-viewer/`)

[three.js](https://threejs.org/)(MIT, `vendor/three/`에 포함)로 렌더링합니다.

- GLB/GLTF(Draco·Meshopt·KTX2 압축 포함), OBJ(+MTL), STL, PLY(메시/점군), FBX, 3MF, DAE
- 텍스처·.bin·.mtl 파일을 함께 선택하면 파일 이름으로 연결
- 회전/확대/이동, 와이어프레임, 격자, 자동 회전, 어두운 배경, Z-up → Y-up 변환, 애니메이션 재생
- 정점·삼각형·재질 수와 크기 표시

### SAM 3 세그멘테이션 (`tools/sam3-panoptic/`)

[SAM 3](https://ai.meta.com/sam3/)(Meta)로 장면 전체를 물체/배경 영역으로 나눕니다(파놉틱). SAM 3는 텍스트 개념별 마스크를 주는 모델이라, 물체(things)·배경(stuff) 단어 목록으로 각각 마스크를 구한 뒤 브라우저에서 하나의 라벨 맵으로 합칩니다(물체 > 배경, 같은 종류는 신뢰도 높은 쪽, 물체는 인스턴스별).

두 가지 실행 방식:

- **기기에서 (기본, 실험)** — [rusen/sam3-browser-int8](https://huggingface.co/rusen/sam3-browser-int8)의 `compact-448` INT8 모델을 ONNX Runtime Web(`vendor/onnxruntime-web/`, MIT)으로 실행. 이미지가 기기 밖으로 나가지 않음.
  - 첫 실행 때 이미지 인코더(약 462MB) + 디코더(약 36MB)를 Hugging Face에서 받아 Cache Storage에 저장
  - 기본 단어 목록의 텍스트 특징은 `text-embeddings.*`로 미리 계산해 둠 → 텍스트 모델(355MB) 불필요. 목록에 없는 단어를 쓰면 그때 텍스트 모델과 CLIP 토크나이저(`clip-tokenizer.js`)를 받아 계산
  - onnxruntime-web 1.31에서 이 모델은 그래프 최적화를 켜면 로딩이 실패(ShapeInferenceError)해서 인코더는 최적화를 끔. 멀티스레드 WASM은 초기화가 멈춰서 단일 스레드 사용
  - 측정(헤드리스 Chromium, x86 CPU 1스레드): 이미지 분석 약 32초 + 단어 37개 약 57초. 결과는 파이썬 onnxruntime 참조 실행과 일치
  - 기본 단어 목록을 바꾸면 `scripts/sam3-text-embeddings.py`로 텍스트 특징을 다시 생성
- **서버에서** — Roboflow Serverless API. 페이지에서 **프라이빗** API 키 입력 필요(기기에만 저장). 퍼블리셔블 키(`rf_…`)는 `401 not authorized for serverless inference`로 거절됨

## 로컬 실행

```
python3 -m http.server 8000
```

`http://localhost:8000` 접속 (Web Worker 때문에 `file://`로 직접 열면 동작하지 않습니다).

## 배포 시 캐시

GitHub Pages는 파일을 최대 10분간 캐시합니다. JS/CSS를 수정하면 각 `index.html`의 `?v=` 값을 함께 올려서, 새 HTML이 예전 JS를 불러오는 일이 없게 합니다.
