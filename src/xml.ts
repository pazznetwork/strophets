/** PrivateConstants: DOM Element Type Constants
 *  DOM element types.
 *
 *  ElementType.NORMAL - Normal element.
 *  ElementType.TEXT - Text data element.
 *  ElementType.FRAGMENT - XHTML fragment element.
 */
import { XHTML } from './xhtml';
import { Builder } from './builder';

export enum ElementType {
  NORMAL = 1,
  TEXT = 3,
  CDATA = 4,
  FRAGMENT = 11,
}

/**
 *  Map a function over some or all child elements of a given element.
 *
 *  This is a small convenience function for mapping a function over
 *  some or all of the children of an element.  If elemName is null, all
 *  children will be passed to the function, otherwise only children
 *  whose tag names match elemName will be passed.
 *
 *  Parameters:
 *
 *    @param elem - The xml element to operate on in an Element object.
 *    @param elemName - The child element tag name filter.
 *    @param func - The function to apply to each child.  This
 *      function should take a single argument, a DOM element. A return value will be ignored.
 */
export function forEachChildMap<U>(
  elem: Element,
  elemName: string,
  func: (child: Element) => U
): U[] {
  return Array.from(elem.childNodes)
    .filter(
      (node) => node.nodeType === ElementType.NORMAL && (!elemName || isTagEqual(node, elemName))
    )
    .map(func);
}

/** Function: isTagEqual
 *  Compare an element's tag name with a string.
 *
 *  This function is case-sensitive.
 *
 *  Parameters:
 *
 *   @param el - A XMLElement in a DOM element.
 *   @param name - The element name.
 *
 *  Returns:
 *    @returns true if the element's tag name matches _el_, and false
 *    otherwise.
 */
export function isTagEqual(el: Node, name: string): boolean {
  return el.nodeName === name;
}

/** Function: xmlGenerator
 *  Get the DOM document to generate elements.
 *
 *  Returns:
 *
 *    @returns The currently used DOM document.
 */
export function xmlGenerator(): Document {
  return document.implementation.createDocument('jabber:client', 'strophe', null);
}

/** Function: xmlElement
 *  Create an XML DOM element.
 *
 *  This function creates an XML DOM element correctly across all
 *  implementations. Note that these are not HTML DOM elements, which
 *  aren't appropriate for XMPP stanzas.
 *
 *  Parameters:
 *
 *    @param name - The name for the element.
 *    @param options
 *    attrs - An optional array or object containing
 *      key/value pairs to use as element attributes. The object should
 *      be in the format {'key': 'value'} or {key: 'value'}. The array
 *      should have the format [['key1', 'value1'], ['key2', 'value2']].
 *    text - The text child data for the element.
 *
 *  Returns:
 *    @returns A new XML DOM element.
 */
export function xmlElement(
  name: string,
  options?: { text?: string; attrs?: Record<string, string> | [string, string][] }
): Element {
  if (!name) {
    return null;
  }

  const { text, attrs } = options;

  const node = xmlGenerator().createElement(name);

  if (text) {
    node.appendChild(xmlTextNode(text));
  }

  if (Array.isArray(attrs)) {
    for (const attr of attrs) {
      if (Array.isArray(attr) && attr[0] != null && attr[1] != null) {
        node.setAttribute(attr[0], attr[1]);
      }
    }
    return node;
  }

  if (typeof attrs === 'object' && !!attrs) {
    Object.entries(attrs)
      .filter(([key, value]) => !!key && !!value)
      .map(([key, value]) => node.setAttribute(key, value));
  }

  return node;
}

/**  Function: xmlescape
 *  Escapes invalid xml characters.
 *
 *  Parameters:
 *
 *     @param text - text to escape.
 *
 *  Returns:
 *     @returns Escaped text.
 */
export function xmlescape(text: string): string {
  text = text.replace(/&/g, '&amp;');
  text = text.replace(/</g, '&lt;');
  text = text.replace(/>/g, '&gt;');
  text = text.replace(/'/g, '&apos;');
  text = text.replace(/"/g, '&quot;');
  return text;
}

/**  Function: xmlunescape
 *  Unescapes invalid xml characters.
 *
 *  Parameters:
 *
 *     @param text - text to unescape.
 *
 *  Returns:
 *     @returns Unescaped text.
 */
export function xmlunescape(text: string): string {
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&apos;/g, "'");
  text = text.replace(/&quot;/g, '"');
  return text;
}

/** Function: xmlTextNode
 *  Creates an XML DOM text node.
 *
 *  Provides a cross implementation version of document.createTextNode.
 *
 *  Parameters:
 *
 *    @param text - The content of the text node.
 *
 *  Returns:
 *   @returns A new XML DOM text node.
 */
export function xmlTextNode(text: string): Text {
  return xmlGenerator().createTextNode(text);
}

/** Function: xmlHtmlNode
 *  Creates an XML DOM html node.
 *
 *  Parameters:
 *
 *    @param html - The content of the html node.
 *
 *  Returns:
 *   @returns A new XML DOM text node.
 */
export function xmlHtmlNode(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/xml');
}

/** Function: getText
 *  Get the concatenation of all text children of an element.
 *
 *  Parameters:
 *
 *    @param elem - A XMLElement as DOM element.
 *
 *  Returns:
 *    @returns A String with the concatenated text of all text element children.
 */
export function getText(elem: Element): string {
  if (!elem) {
    return null;
  }

  let str = '';
  if (elem.childNodes.length === 0 && elem.nodeType === ElementType.TEXT) {
    str += elem.nodeValue;
  }
  for (const childNode of Array.from(elem.childNodes)) {
    if (childNode.nodeType === ElementType.TEXT) {
      str += childNode.nodeValue;
    }
  }
  return xmlescape(str);
}

/** Function: copyElement
 *  Copy an XML DOM element.
 *
 *  This function copies a DOM element and all its descendants and returns
 *  the new copy.
 *
 *  Parameters:
 *
 *    @param elem - A XMLElement as a DOM element.
 *
 *  Returns:
 *    @returns A new, copied DOM element tree.
 */
export function copyElement(elem: Element): Element {
  return elem.cloneNode(true) as Element;
}

/** Function: createHtml
 *  Copy an HTML DOM element into an XML DOM.
 *
 *  This function copies a DOM element and all its descendants and returns
 *  the new copy. If all elements and attributes satisfy the XHTML specification
 *
 *  Parameters:
 *
 *    @param elem - A HTMLElement.
 *
 *  Returns:
 *    @returns A new, copied XML Node tree.
 */
export function createHtml(elem: HTMLElement): Node {
  // return new DOMParser().parseFromString(elem.outerHTML, 'text/xml').documentElement;

  if (elem.nodeType === ElementType.NORMAL) {
    const tag = elem.nodeName.toLowerCase(); // XHTML tags must be lower case.
    if (!XHTML.validTag(tag)) {
      const el = xmlGenerator().createDocumentFragment();
      for (const node of Array.from(elem.childNodes)) {
        el.appendChild(createHtml(node as HTMLElement));
      }
      return el;
    }

    try {
      const el = xmlElement(tag);
      for (const attribute of XHTML.attributes[tag]) {
        let value = elem.getAttribute(attribute);
        if (
          typeof value === 'undefined' ||
          value === null ||
          value === '' ||
          value === 'false' ||
          value === '0'
        ) {
          continue;
        }
        // filter out invalid css styles
        if (attribute === 'style') {
          const css = [];
          const cssAttrs = value.split(';');
          for (const cssAttr of cssAttrs) {
            const attr = cssAttr.split(':');
            const cssName = attr[0].replace(/^\s*/, '').replace(/\s*$/, '').toLowerCase();
            if (XHTML.validCSS(cssName)) {
              const cssValue = attr[1].replace(/^\s*/, '').replace(/\s*$/, '');
              css.push(cssName + ': ' + cssValue);
            }
          }
          if (css.length > 0) {
            value = css.join('; ');
            el.setAttribute(attribute, value);
          }
        } else {
          el.setAttribute(attribute, value);
        }
      }
      for (const node of Array.from(elem.childNodes)) {
        el.appendChild(createHtml(node as HTMLElement));
      }
    } catch (e) {
      // invalid elements
      return xmlTextNode('');
    }
  }

  if (elem.nodeType === ElementType.FRAGMENT) {
    const el = xmlGenerator().createDocumentFragment();
    for (const node of Array.from(elem.childNodes)) {
      el.appendChild(createHtml(node as HTMLElement));
    }
    return el;
  }

  if (elem.nodeType === ElementType.TEXT) {
    return xmlTextNode(elem.nodeValue);
  }

  return xmlTextNode('');
}

/** Function: escapeNode
 *  Escape the node part (also called local part) of a JID.
 *
 *  Parameters:
 *
 *    @param node - A node (or local part).
 *
 *  Returns:
 *    @returns An escaped node (or local part).
 */
export function escapeNode(node: string): string {
  return node
    .replace(/^\s+|\s+$/g, '')
    .replace(/\\/g, '\\5c')
    .replace(/ /g, '\\20')
    .replace(/"/g, '\\22')
    .replace(/&/g, '\\26')
    .replace(/'/g, '\\27')
    .replace(/\//g, '\\2f')
    .replace(/:/g, '\\3a')
    .replace(/</g, '\\3c')
    .replace(/>/g, '\\3e')
    .replace(/@/g, '\\40');
}

/** Function: unescapeNode
 *  Unescape a node part (also called local part) of a JID.
 *
 *  Parameters:
 *
 *    @param node - A node (or local part).
 *
 *  Returns:
 *   @returns An unescaped node (or local part).
 */
export function unescapeNode(node: string): string {
  return node
    .replace(/\\20/g, ' ')
    .replace(/\\22/g, '"')
    .replace(/\\26/g, '&')
    .replace(/\\27/g, "'")
    .replace(/\\2f/g, '/')
    .replace(/\\3a/g, ':')
    .replace(/\\3c/g, '<')
    .replace(/\\3e/g, '>')
    .replace(/\\40/g, '@')
    .replace(/\\5c/g, '\\');
}

/** Function: getNodeFromJid
 *  Get the node portion of a JID String.
 *
 *  Parameters:
 *
 *    @param jid - A JID.
 *
 *  Returns:
 *   @returns A String containing the node.
 */
export function getNodeFromJid(jid: string): string {
  if (jid.indexOf('@') < 0) {
    return null;
  }
  return jid.split('@')[0];
}

/** Function: getDomainFromJid
 *  Get the domain portion of a JID String.
 *
 *  Parameters:
 *
 *    @param jid - A JID.
 *
 *  Returns:
 *    @returns A String containing the domain.
 */
export function getDomainFromJid(jid: string): string {
  const bare = getBareJidFromJid(jid);
  if (bare.indexOf('@') < 0) {
    return bare;
  } else {
    const parts = bare.split('@');
    parts.splice(0, 1);
    return parts.join('@');
  }
}

/** Function: getResourceFromJid
 *  Get the resource portion of a JID String.
 *
 *  Parameters:
 *
 *    @param jid - A JID.
 *
 *  Returns:
 *    @returns A String containing the resource.
 */
export function getResourceFromJid(jid: string): string {
  if (!jid) {
    return null;
  }
  const s = jid.split('/');
  if (s.length < 2) {
    return null;
  }
  s.splice(0, 1);
  return s.join('/');
}

/** Function: getBareJidFromJid
 *  Get the bare JID from a JID String.
 *
 *  Parameters:
 *
 *    @param jid - A JID.
 *
 *  Returns:
 *    @returns A String containing the bare JID.
 */
export function getBareJidFromJid(jid: string): string {
  return jid ? jid.split('/')[0] : null;
}

/** Function: serialize
 *  Render a DOM element and all descendants to a String.
 *
 *  Parameters:
 *
 *    @param el - A XMLElement as DOM element or a Builder or an object
 *    with a tree function returning a DOMElement.
 *
 *  Returns:
 *    @returns The serialized element tree as a String.
 */
export function serialize(el: Element | Builder | { tree: () => Element }): string {
  if (!el) {
    return null;
  }
  const elem: Element = !(el instanceof Element) ? el.tree() : el;
  const names = Array.from(elem.attributes).map((attribute) => attribute.localName);
  names.sort();
  let result = names.reduce(
    (a, n) => `${a} ${n}="${xmlescape(elem.attributes.getNamedItem(n).value)}"`,
    `<${elem.nodeName}`
  );

  if (elem.childNodes.length > 0) {
    result += '>';
    for (const child of Array.from(elem.childNodes)) {
      switch (child.nodeType) {
        case ElementType.NORMAL:
          // normal element, so recurse
          result += serialize(child as Element);
          break;
        case ElementType.TEXT:
          // text element to escape values
          result += xmlescape(child.nodeValue);
          break;
        case ElementType.CDATA:
          // cdata section so don't escape values
          result += '<![CDATA[' + child.nodeValue + ']]>';
      }
    }
    result += '</' + elem.nodeName + '>';
  } else {
    result += '/>';
  }
  return result;
}
