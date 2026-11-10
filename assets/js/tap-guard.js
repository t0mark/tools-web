/*
 * 페이지 이동 직후 터치 무시
 * 휴대폰에서 이전 화면의 카드를 탭한 터치가 새 페이지의 같은 위치(업로드 영역)로 한 번 더 전달되어
 * 파일 선택 창이 바로 열리는 문제를 막는다. 페이지가 보이고 0.7초 안의 업로드 영역 클릭은 무시.
 */
(() => {
  const GUARD_MS = 700;
  let shownAt = performance.now();
  window.addEventListener('pageshow', () => { shownAt = performance.now(); });
  document.addEventListener('click', (e) => {
    if (performance.now() - shownAt > GUARD_MS) return;
    if (e.target.closest && e.target.closest('.dropzone, label[for="file-input"]')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
})();
