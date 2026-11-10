# Tools Web

모바일 우선 웹 도구 모음. 빌드 과정 없는 정적 사이트라서 GitHub Pages 등에 그대로 올리면 됩니다.
SAM 3 도구를 제외한 모든 처리는 브라우저 안에서 이루어지고, 파일이 서버로 전송되지 않습니다.

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

[SAM 3](https://ai.meta.com/sam3/)(Meta)로 장면 전체를 물체/배경 영역으로 나눕니다(파놉틱). **이 도구만 이미지를 외부 서버(Roboflow Serverless API)로 전송**합니다.

- SAM 3는 텍스트 개념별 마스크를 주는 모델이라, 물체(things)·배경(stuff) 단어 목록을 보내고(요청당 16개씩) 결과를 브라우저에서 하나의 라벨 맵으로 합칩니다. 물체가 배경보다 우선, 같은 종류는 신뢰도 높은 쪽, 물체는 인스턴스별(자동차 1, 2…), 배경은 클래스별 한 영역.
- 신뢰도 기준·색 진하기·경계선·라벨 조절, 영역을 눌러 강조, PNG 저장, 찾을 대상 목록 수정(영어 단어)
- **API 키**: Roboflow 프라이빗 키를 비밀번호로 암호화해 `app.js`의 `ENCRYPTED_KEY`에 넣어 두고, 페이지에서 비밀번호를 입력하면 브라우저에서 복호화해 사용합니다(PBKDF2-SHA256 600,000회 → AES-256-GCM).
  - ⚠ 리포가 공개라 암호문도 공개입니다. 짧은 비밀번호는 대입 공격으로 풀릴 수 있으니, 키 유출 시에는 Roboflow에서 키를 재발급하세요.
  - 키·비밀번호 변경: `KEY='새 키' PASSWORD='새 비밀번호' node scripts/encrypt-key.mjs` 결과로 `ENCRYPTED_KEY`를 바꾸고 `index.html`의 `?v=` 값을 올립니다.
  - 퍼블리셔블 키(`rf_…`)는 서버리스 API에서 `401 not authorized for serverless inference`로 거절됩니다.
- 참고: 기기 안에서 직접 실행하는 버전(ONNX Runtime Web + INT8 SAM 3)도 만들어 검증했지만 PC CPU 기준 한 장에 약 1분 30초가 걸려 제외했습니다(커밋 9f9a790 참고).

## 로컬 실행

```
python3 -m http.server 8000
```

`http://localhost:8000` 접속 (Web Worker 때문에 `file://`로 직접 열면 동작하지 않습니다).

## 배포 시 캐시

GitHub Pages는 파일을 최대 10분간 캐시합니다. JS/CSS를 수정하면 각 `index.html`의 `?v=` 값을 함께 올려서, 새 HTML이 예전 JS를 불러오는 일이 없게 합니다.
