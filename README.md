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

동영상의 오디오 트랙을 실제 MP3(MPEG-1 Layer III, CBR, 44.1kHz)로 다시 인코딩합니다. 확장자만 바꾸는 방식이 아닙니다.

1. 브라우저 내장 디코더(Web Audio `decodeAudioData`)로 오디오(AAC 등)를 PCM으로 디코딩
2. Web Worker에서 [lamejs](https://github.com/zhuker/lamejs)(LAME의 JS 포팅, LGPL)로 MP3 인코딩
3. 비트레이트 64/128/192/320kbps, 스테레오/모노 선택 → 예상 용량 미리 표시
4. 다운로드, 또는 모바일에서 공유 시트로 저장/전송

5.1ch 등 다채널 오디오는 자동으로 스테레오/모노로 다운믹스됩니다.
파일 전체를 메모리에 올려서 처리하므로, 휴대폰에서는 아주 긴 영상(대략 1시간 이상)은 메모리 부족으로 실패할 수 있습니다.

## 로컬 실행

```
python3 -m http.server 8000
```

`http://localhost:8000` 접속 (Web Worker 때문에 `file://`로 직접 열면 동작하지 않습니다).
