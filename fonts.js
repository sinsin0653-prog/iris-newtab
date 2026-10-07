// 丸ゴシック（Google Fonts）。HTML に直接書くと、Google に繋がらないとき画面全体の表示が止まるので、
// スクリプトから後で読み込む（届くまでは端末の丸ゴシックで表示）
export const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&display=swap';

export function loadFonts(doc = document) {
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONT_CSS;
  doc.head.appendChild(link);
}
