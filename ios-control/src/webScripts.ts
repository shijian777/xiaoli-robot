export const CLEAR_SITE_DATA_MESSAGE = 'xiaoli-control:site-data-cleared';

export const HIDE_APK_LINKS_SCRIPT = `
(() => {
  const removeApkLinks = () => {
    document.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (/\\.apk(?:[?#]|$)/i.test(href)) {
        link.remove();
      }
    });
  };
  removeApkLinks();
  new MutationObserver(removeApkLinks).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
true;
`;

export const CLEAR_SITE_DATA_SCRIPT = `
(() => {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.cookie.split(';').forEach((entry) => {
      const separator = entry.indexOf('=');
      const name = (separator >= 0 ? entry.slice(0, separator) : entry).trim();
      if (name) {
        document.cookie = name + '=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax';
      }
    });
  } finally {
    window.ReactNativeWebView.postMessage('${CLEAR_SITE_DATA_MESSAGE}');
  }
})();
true;
`;
