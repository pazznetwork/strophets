export function utf16to8(str: string): string {
  let out = '';
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0x0000 && c <= 0x007f) {
      out += str.charAt(i);
    } else if (c > 0x07ff) {
      out += String.fromCharCode(0xe0 | ((c >> 12) & 0x0f));
      out += String.fromCharCode(0x80 | ((c >> 6) & 0x3f));
      out += String.fromCharCode(0x80 | ((c >> 0) & 0x3f));
    } else {
      out += String.fromCharCode(0xc0 | ((c >> 6) & 0x1f));
      out += String.fromCharCode(0x80 | ((c >> 0) & 0x3f));
    }
  }
  return out;
}

export function xorArrayBuffers(x: ArrayBufferLike, y: ArrayBufferLike): ArrayBufferLike {
  const xIntArray = new Uint8Array(x);
  const yIntArray = new Uint8Array(y);
  const zIntArray = new Uint8Array(x.byteLength);
  for (let i = 0; i < x.byteLength; i++) {
    zIntArray[i] = xIntArray[i] ^ yIntArray[i];
  }
  return zIntArray.buffer;
}

export function arrayBufToBase64(buffer: ArrayBufferLike): string {
  // This function is due to mobz (https://stackoverflow.com/users/1234628/mobz)
  //  and Emmanuel (https://stackoverflow.com/users/288564/emmanuel)
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export function base64ToArrayBuf(str: string): ArrayBufferLike {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0))?.buffer;
}

export function stringToArrayBuf(str: string): ArrayBufferLike {
  //utf-8
  const bytes = new TextEncoder().encode(str);
  return bytes.buffer;
}

export function addCookies(cookies: Record<string, Record<string, string>>): void {
  /* Parameters:
   *  (Object) cookies - either a map of cookie names
   *    to string values or to maps of cookie values.
   *
   * For example:
   * { "myCookie": "1234" }
   *
   * or:
   * { "myCookie": {
   *      "value": "1234",
   *      "domain": ".example.org",
   *      "path": "/",
   *      "expires": expirationDate
   *      }
   *  }
   *
   *  These values get passed to Strophe.Connection via
   *   options.cookies
   */
  cookies = cookies || {};
  for (const cookieName in cookies) {
    if (Object.prototype.hasOwnProperty.call(cookies, cookieName)) {
      let expires = '';
      let domain = '';
      let path = '';
      const cookieObj = cookies[cookieName];
      const isObj = typeof cookieObj === 'object';
      const cookieValue = escape(unescape(isObj ? cookieObj.value : cookieObj));
      if (isObj && cookieObj) {
        expires = cookieObj.expires ? ';expires=' + cookieObj.expires : '';
        domain = cookieObj.domain ? ';domain=' + cookieObj.domain : '';
        path = cookieObj.path ? ';path=' + cookieObj.path : '';
      }
      document.cookie = cookieName + '=' + cookieValue + expires + domain + path;
    }
  }
}
