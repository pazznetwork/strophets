import { Connection } from './connection';
import { serialize } from './xml';
import { debug, error } from './log';
import { ErrorCondition } from './error';

/**
 *  _Private_ helper class that provides a cross implementation abstraction
 *  for a BOSH related XMLHttpRequest.
 *
 *  The Strophe.Request class is used internally to encapsulate BOSH request
 *  information.  It is not meant to be used from user's code.
 */
export class Request {
  readonly id: number;
  private xmlData: Element;
  private data: string;
  private origFunc: (req: Request) => void;
  private func: (req: Request) => void;
  date: number;
  abort: boolean;
  dead: any;
  xhr: XMLHttpRequest;

  get age(): number {
    if (!this.date) {
      return 0;
    }
    const now = new Date().getDate();
    return (now - this.date) / 1000;
  }

  get timeDead(): number {
    if (!this.dead) {
      return 0;
    }
    const now = new Date().getDate();
    return (now - this.dead) / 1000;
  }

  /**
   *  Create and initialize a new Strophe.Request object.
   *
   *  Parameters:
   *
   *    @param elem - The XML data to be sent in the request.
   *    @param func - The function that will be called when the
   *      XMLHttpRequest readyState changes.
   *    @param rid - The BOSH rid attribute associated with this request.
   *    @param sends - The number of times this same request has been sent.
   */
  constructor(elem: Element, func: (req: Request) => void, readonly rid: number, readonly sends = 0) {
    this.id = ++Connection._requestId;
    this.xmlData = elem;
    this.data = serialize(elem);
    // save original function in case we need to make a new request
    // from this one.
    this.origFunc = func;
    this.func = func;
    this.date = NaN;
    this.abort = false;
    this.dead = null;

    this.xhr = this._newXHR();
  }

  /** PrivateFunction: getResponse
   *  Get a response from the underlying XMLHttpRequest.
   *
   *  This function attempts to get a response from the request and checks
   *  for errors.
   *
   *  Throws:
   *    "parsererror" - A parser error occured.
   *    "bad-format" - The entity has sent XML that cannot be processed.
   *
   *  Returns:
   *
   *    @returns The DOM element tree of the response.
   */
  getResponse(): Element {
    let node = null;
    if (this.xhr.responseXML && this.xhr.responseXML.documentElement) {
      node = this.xhr.responseXML.documentElement;
      if (node.tagName === 'parsererror') {
        error('invalid response received');
        error('responseText: ' + this.xhr.responseText);
        error('responseXML: ' + serialize(this.xhr.responseXML.documentElement));
        throw new Error('parsererror');
      }
    } else if (this.xhr.responseText) {
      // In React Native, we may get responseText but no responseXML.  We can try to parse it manually.
      debug('Got responseText but no responseXML; attempting to parse it with DOMParser...');
      node = new DOMParser().parseFromString(this.xhr.responseText, 'application/xml').documentElement;
      if (!node) {
        throw new Error('Parsing produced null node');
      } else if (node.querySelector('parsererror')) {
        error('invalid response received: ' + node.querySelector('parsererror').textContent);
        error('responseText: ' + this.xhr.responseText);
        const errorItem = new Error();
        errorItem.name = ErrorCondition.BAD_FORMAT;
        throw errorItem;
      }
    }
    return node;
  }

  /** PrivateFunction: _newXHR
   *  _Private_ helper function to create XMLHttpRequests.
   *
   *  This function creates XMLHttpRequests across all implementations.
   *
   *  Returns:
   *
   *   @returns  A new XMLHttpRequest.
   */
  _newXHR(): XMLHttpRequest {
    this.xhr = new XMLHttpRequest();
    this.xhr.overrideMimeType('text/xml; charset=utf-8');
    // use Function.bind() to prepend ourselves as an argument
    this.xhr.onreadystatechange = this.func.bind(null, this);
    return this.xhr;
  }
}
