import { Connection } from './connection';
import { NS } from './namespace';
import { Request } from './request';
import { $build } from './builder-helper';
import { getBareJidFromJid, getDomainFromJid, getNodeFromJid } from './xml';
import { debug, error, warn } from './log';
import { Status } from './status';
import { SECONDARY_TIMEOUT, TIMEOUT } from './timeout';
import { ProtocolManager } from './protocol-manager';
import { Subject, takeUntil } from 'rxjs';

/**
 *  The Bosh class is used internally by the Connection class to encapsulate BOSH sessions.
 */
export class Bosh implements ProtocolManager {
  rid = Math.floor(Math.random() * 4294967295);
  private sid: string = null;

  // default BOSH values
  hold = 1;
  wait = 60;
  limit = 5;
  errors = 0;
  private inactivity: number;

  private lastResponseHeaders: string;
  private readonly _requests: any[];

  private destroySubject = new Subject<void>();
  private readonly noResumeableBOSHSessionSubject = new Subject<void>();
  noResumeableBOSHSession$ = this.noResumeableBOSHSessionSubject.asObservable();

  /**
   *  BOSH-Connections will have all stanzas wrapped in a <body> tag when
   *  passed to <Strophe.Connection.xmlInput> or <Strophe.Connection.xmlOutput>.
   *  To strip this tag, User code can set <Strophe.Bosh.strip> to "body":
   *
   *  > Strophe.Bosh.prototype.strip = "body";
   *
   *  This will enable stripping of the body tag in both
   *  <Strophe.Connection.xmlInput> and <Strophe.Connection.xmlOutput>.
   */
  strip: string;

  jid: string;

  /**
   *  Create and initialize a Strophe.Bosh object.
   *
   *  Parameters:
   *
   *    @param connection connection - The Strophe.Connection that will use BOSH.
   *    @param prebindUrl
   */
  constructor(readonly connection: Connection, private readonly prebindUrl?: string) {
    this.connection.userJid$.pipe(takeUntil(this.destroySubject)).subscribe((newJid) => (this.jid = newJid));

    /* request id for body tags */
    this.rid = Math.floor(Math.random() * 4294967295);
    /* The current session ID. */
    this.sid = null;

    this.lastResponseHeaders = null;
    this._requests = [];
  }

  /**
   *  function that initializes the BOSH connection.
   *
   *  Creates and sends the Request that initializes the BOSH connection.
   *
   * @param wait - The optional HTTPBIND wait value.  This is the
   *      time the server will wait before returning an empty result for
   *      a request.  The default setting of 60 seconds is recommended.
   * @param hold - The optional HTTPBIND hold value.  This is the
   *      number of connections the server will hold at one time.  This
   *      should almost always be set to 1 (the default).
   * @param route - The optional route value.
   */
  connect(wait?: number, hold?: number, route?: string) {
    this.wait |= wait;
    this.hold |= hold;
    this.errors = 0;

    const body = this._buildBody().attrs({
      to: this.connection.domain,
      'xml:lang': 'en',
      wait: this.wait.toString(10),
      hold: this.hold.toString(10),
      content: 'text/xml; charset=utf-8',
      ver: '1.6',
      'xmpp:version': '1.0',
      'xmlns:xmpp': NS.BOSH
    });
    if (route) {
      body.attrs({ route });
    }

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const connectCb = this.connection._connect_cb;
    this._requests.push(
      new Request(
        body.tree(),
        this._onRequestStateChange.bind(this, connectCb.bind(this.connection)),
        Number.parseInt(body.tree().getAttribute('rid'), 10)
      )
    );
    this._throttledRequestHandler();
  }

  /**
   *  helper function to generate the <body/> wrapper for BOSH.
   *
   *  Returns:
   *    A Builder with a <body/> element.
   */
  _buildBody() {
    const bodyWrap = $build('body', {
      rid: (this.rid++).toString(),
      xmlns: NS.HTTPBIND
    });
    if (this.sid !== null) {
      bodyWrap.attrs({ sid: this.sid });
    }
    if (this.connection.options.keepalive) {
      this._cacheSession();
    }
    return bodyWrap;
  }

  /**
   *  Reset the connection.
   *
   *  This function is called by the reset function of the Strophe Connection
   */
  reset() {
    this.rid = Math.floor(Math.random() * 4294967295);
    this.sid = null;
    this.errors = 0;
    globalThis.sessionStorage.removeItem('strophe-bosh-session');

    this.connection.nextValidRid(this.rid);
  }

  /**
   *  Attach to an already created and authenticated BOSH session.
   *
   *  This function is provided to allow Strophe to attach to BOSH
   *  sessions which have been created externally, perhaps by a Web
   *  application.  This is often used to support auto-login type features
   *  without putting user credentials into the page.
   *
   *  Parameters:
   *    (String) jid - The full JID that is bound by the session.
   *    (String) sid - The SID of the BOSH session.
   *    (String) rid - The current RID of the BOSH session.  This RID
   *      will be used by the next request.
   *    (Function) callback The connect-callback function.
   *    (Integer) wait - The optional HTTPBIND wait value.  This is the
   *      time the server will wait before returning an empty result for
   *      a request.  The default setting of 60 seconds is recommended.
   *      Other settings will require tweaks to the Strophe.TIMEOUT value.
   *    (Integer) hold - The optional HTTPBIND hold value.  This is the
   *      number of connections the server will hold at one time.  This
   *      should almost always be set to 1 (the default).
   *    (Integer) limit - The optional HTTBIND limitow value.  This is the
   *      allowed range of request ids that are valid.  The default is 5.
   */
  attach(
    jid: string,
    sid: string,
    rid: number,
    callback: (status: number, condition: string, elem: Element) => unknown,
    wait: number,
    hold: number,
    limit: number
  ): void {
    this.connection.jid = jid;
    this.sid = sid;
    this.rid = rid;

    this.connection.connect_callback = callback;
    this.connection.domain = getDomainFromJid(this.connection.jid);
    this.connection.authenticated = true;
    this.connection.connected = true;

    this.wait |= wait;
    this.hold |= hold;
    this.limit |= limit;

    this.connection.changeConnectStatus(Status.ATTACHED, null);
  }

  /**
   *  Attempt to restore a cached BOSH session
   *
   *  Parameters:
   *    (String) jid - The full JID that is bound by the session.
   *      This parameter is optional but recommended, specifically in cases
   *      where prebinded BOSH sessions are used where it's important to know
   *      that the right session is being restored.
   *    (Function) callback The connect callback function.
   *    (Integer) wait - The optional HTTPBIND wait value.  This is the
   *      time the server will wait before returning an empty result for
   *      a request.  The default setting of 60 seconds is recommended.
   *      Other settings will require tweaks to the Strophe.TIMEOUT value.
   *    (Integer) hold - The optional HTTPBIND hold value.  This is the
   *      number of connections the server will hold at one time.  This
   *      should almost always be set to 1 (the default).
   *    (Integer) limit - The optional HTTBIND window value.  This is the
   *      allowed range of request ids that are valid.  The default is 5.
   */
  restore(
    jid: string,
    callback: (status: number, condition: string, elem: Element) => unknown,
    wait?: number,
    hold?: number,
    limit?: number
  ): void {
    const session = JSON.parse(window.sessionStorage.getItem('strophe-bosh-session'));
    if (
      typeof session !== 'undefined' &&
      session !== null &&
      session.rid &&
      session.sid &&
      session.jid &&
      (typeof jid === 'undefined' ||
        jid === null ||
        getBareJidFromJid(session.jid) === getBareJidFromJid(jid) ||
        // If authcid is null, then it's an anonymous login, so
        // we compare only the domains:
        (getNodeFromJid(jid) === null && getDomainFromJid(session.jid) === jid))
    ) {
      this.connection.restored = true;
      this.attach(session.jid, session.sid, session.rid, callback, wait, hold, limit);
    } else {
      const namedError = new Error('_restore: no restoreable session.');
      namedError.name = 'StropheSessionError';
      throw namedError;
    }
  }

  /**
   *  handler for the beforeunload event.
   *
   *  This handler is used to process the Bosh-part of the initial request.
   *  Parameters:
   *    (Strophe.Request) bodyWrap - The received stanza.
   */
  _cacheSession() {
    if (this.connection.authenticated) {
      if (this.connection.jid && this.rid && this.sid) {
        window.sessionStorage.setItem(
          'strophe-bosh-session',
          JSON.stringify({
            jid: this.connection.jid,
            rid: this.rid,
            sid: this.sid
          })
        );
      }
    } else {
      window.sessionStorage.removeItem('strophe-bosh-session');
    }
  }

  /**
   *  handler for initial connection request.
   *
   *  This handler is used to process the Bosh-part of the initial request.
   *  Parameters:
   *    (Strophe.Request) bodyWrap - The received stanza.
   */
  connectCb(bodyWrap: Element) {
    const typ = bodyWrap.getAttribute('type');
    if (typ !== null && typ === 'terminate') {
      // an error occurred
      let cond = bodyWrap.getAttribute('condition');
      error('BOSH-Connection failed: ' + cond);
      const conflict = bodyWrap.getElementsByTagName('conflict');
      if (cond !== null) {
        if (cond === 'remote-stream-error' && conflict.length > 0) {
          cond = 'conflict';
        }
        this.connection.changeConnectStatus(Status.CONNFAIL, cond);
      } else {
        this.connection.changeConnectStatus(Status.CONNFAIL, 'unknown');
      }
      this.connection.doDisconnect(cond);
      return Status.CONNFAIL;
    }

    // check to make sure we don't overwrite these if _connect_cb is
    // called multiple times in the case of missing stream:features
    if (!this.sid) {
      this.sid = bodyWrap.getAttribute('sid');
    }
    const wind = bodyWrap.getAttribute('requests');
    if (wind) {
      this.limit = parseInt(wind, 10);
    }
    const hold = bodyWrap.getAttribute('hold');
    if (hold) {
      this.hold = parseInt(hold, 10);
    }
    const wait = bodyWrap.getAttribute('wait');
    if (wait) {
      this.wait = parseInt(wait, 10);
    }
    const inactivity = bodyWrap.getAttribute('inactivity');
    if (inactivity) {
      this.inactivity = parseInt(inactivity, 10);
    }

    return Status.CONNECTED;
  }

  /**
   *  part of Connection.disconnect for Bosh
   *
   *  Parameters:
   *    (Request) pres - This stanza will be sent before disconnecting.
   */
  disconnect(pres: Element) {
    this._sendTerminate(pres);
  }

  /**
   *  function to disconnect.
   *
   *  Resets the SID and RID.
   */
  doDisconnect() {
    this.sid = null;
    this.rid = Math.floor(Math.random() * 4294967295);
    globalThis.sessionStorage.removeItem('strophe-bosh-session');

    this.connection.nextValidRid(this.rid);
  }

  /**
   function to check if the Request queue is empty.
   *
   *  Returns:
   *    True, if there are no Requests queued, False otherwise.
   */
  emptyQueue() {
    return this._requests.length === 0;
  }

  /**
   *  function to call error handlers registered for HTTP errors.
   *
   *  Parameters:
   *    (Strophe.Request) req - The request that is changing readyState.
   */
  _callProtocolErrorHandlers(req: Request) {
    const reqStatus = Bosh._getRequestStatus(req);
    const err_callback = this.connection.protocolErrorHandlers.HTTP[reqStatus];
    if (err_callback) {
      err_callback.call(this, reqStatus);
    }
  }

  /**
   *  function to handle the error count.
   *
   *  Requests are resent automatically until their error count reaches
   *  5.  Each time an error is encountered, this function is called to
   *  increment the count and disconnect if the count is too high.
   *
   *  Parameters:
   *    (Integer) reqStatus - The request status.
   */
  _hitError(reqStatus: number) {
    this.errors++;
    warn('request errored, status: ' + reqStatus + ', number of errors: ' + this.errors);
    if (this.errors > 4) {
      this.connection._onDisconnectTimeout();
    }
  }

  /**
   * Called on stream start/restart when no stream:features
   * has been received and sends a blank poll request.
   */
  noAuthReceived(callback: () => void) {
    warn('Server did not yet offer a supported authentication ' + 'mechanism. Sending a blank poll request.');
    if (callback) {
      callback = callback.bind(this.connection);
    } else {
      callback = this.connection._connect_cb.bind(this.connection);
    }
    const body = this._buildBody();
    this._requests.push(
      new Request(body.tree(), this._onRequestStateChange.bind(this, callback), Number.parseInt(body.tree().getAttribute('rid'), 10))
    );
    this._throttledRequestHandler();
  }

  /**
   *  timeout handler for handling non-graceful disconnection.
   *
   *  Cancels all remaining Requests and clears the queue.
   */
  onDisconnectTimeout() {
    this.abortAllRequests();
  }

  /**
   *  helper function that makes sure all pending requests are aborted.
   */
  abortAllRequests() {
    while (this._requests.length > 0) {
      const req = this._requests.pop();
      req.abort = true;
      req.xhr.abort();
      req.xhr.onreadystatechange = () => {};
    }
  }

  /**
   *  handler called by Strophe.Connection._onIdle
   *
   *  Sends all queued Requests or polls with empty Request if there are none.
   */
  onIdle() {
    const data = this.connection.data;
    // if no requests are in progress, poll
    if (this.connection.authenticated && this._requests.length === 0 && data.length === 0 && !this.connection.disconnecting) {
      debug('no requests during idle cycle, sending blank request');
      data.push(null);
    }

    if (this.connection.paused) {
      return;
    }

    if (this._requests.length < 2 && data.length > 0) {
      const body = this._buildBody();
      for (const dataPart of data) {
        if (dataPart !== null && dataPart.tagName !== 'restart') {
          body.cnode(dataPart).up();
          continue;
        }
        body.attrs({
          to: this.connection.domain,
          'xml:lang': 'en',
          'xmpp:restart': 'true',
          'xmlns:xmpp': NS.BOSH
        });
      }
      delete this.connection.data;
      this.connection.data = [];
      this._requests.push(
        new Request(
          body.tree(),
          this._onRequestStateChange.bind(this, this.connection._dataRecv.bind(this.connection)),
          Number.parseInt(body.tree().getAttribute('rid'), 10)
        )
      );
      this._throttledRequestHandler();
    }

    if (this._requests.length > 0) {
      const firstReq = this._requests[0];
      const time_elapsed = firstReq.age();
      if (firstReq.dead && firstReq.timeDead > Math.floor(SECONDARY_TIMEOUT * this.wait)) {
        this._throttledRequestHandler();
      }
      if (time_elapsed > Math.floor(TIMEOUT * this.wait)) {
        warn('Request ' + firstReq.id + ' timed out, over ' + Math.floor(TIMEOUT * this.wait) + ' seconds since last activity');
        this._throttledRequestHandler();
      }
    }
  }

  /**
   *
   *  Returns the HTTP status code from a Strophe.Request
   *
   *  Parameters:
   *    (Strophe.Request) req - The Strophe.Request instance.
   *    (Integer) def - The default value that should be returned if no
   *          status value was found.
   */
  static _getRequestStatus(req: Request, def?: number) {
    let reqStatus;
    if (req.xhr.readyState === 4) {
      try {
        reqStatus = req.xhr.status;
      } catch (e) {
        // ignore errors from undefined status attribute. Works
        // around a browser bug
        error("Caught an error while retrieving a request's status, " + 'reqStatus: ' + reqStatus);
      }
    }
    if (typeof reqStatus === 'undefined') {
      reqStatus = typeof def === 'number' ? def : 0;
    }
    return reqStatus;
  }

  /**
   *  handler for Strophe.Request state changes.
   *
   *  This function is called when the XMLHttpRequest readyState changes.
   *  It contains a lot of error handling logic for the many ways that
   *  requests can fail, and calls the request callback when requests
   *  succeed.
   *
   *  Parameters:
   *    (Function) func - The handler for the request.
   *    (Strophe.Request) req - The request that is changing readyState.
   */
  _onRequestStateChange(func: (req: Request) => void, req: Request) {
    debug('request id ' + req.id + '.' + req.sends + ' state changed to ' + req.xhr.readyState);
    if (req.abort) {
      req.abort = false;
      return;
    }
    if (req.xhr.readyState !== 4) {
      // The request is not yet complete
      return;
    }
    const reqStatus = Bosh._getRequestStatus(req);
    this.lastResponseHeaders = req.xhr.getAllResponseHeaders();
    if (this.connection.disconnecting && reqStatus >= 400) {
      this._hitError(reqStatus);
      this._callProtocolErrorHandlers(req);
      return;
    }

    const reqIs0 = this._requests[0] === req;
    const reqIs1 = this._requests[1] === req;

    const valid_request = reqStatus > 0 && reqStatus < 500;
    const too_many_retries = req.sends > this.connection.maxRetries;
    if (valid_request || too_many_retries) {
      // remove from internal queue
      this._removeRequest(req);
      debug('request id ' + req.id + ' should now be removed');
    }

    if (reqStatus === 200) {
      // request succeeded
      // if request 1 finished, or request 0 finished and request
      // 1 is over SECONDARY_TIMEOUT seconds old, we need to
      // restart the other - both will be in the first spot, as the
      // completed request has been removed from the queue already
      if (reqIs1 || (reqIs0 && this._requests.length > 0 && this._requests[0].age() > Math.floor(SECONDARY_TIMEOUT * this.wait))) {
        this._restartRequest(0);
      }
      this.connection.nextValidRid(Number(req.rid) + 1);
      debug('request id ' + req.id + '.' + req.sends + ' got 200');
      func(req); // call handler
      this.errors = 0;
    } else if (reqStatus === 0 || (reqStatus >= 400 && reqStatus < 600) || reqStatus >= 12000) {
      // request failed
      error('request id ' + req.id + '.' + req.sends + ' error ' + reqStatus + ' happened');
      this._hitError(reqStatus);
      this._callProtocolErrorHandlers(req);
      if (reqStatus >= 400 && reqStatus < 500) {
        this.connection.changeConnectStatus(Status.DISCONNECTING, null);
        this.connection.doDisconnect();
      }
    } else {
      error('request id ' + req.id + '.' + req.sends + ' error ' + reqStatus + ' happened');
    }

    if (!valid_request && !too_many_retries) {
      this._throttledRequestHandler();
    } else if (too_many_retries && !this.connection.connected) {
      this.connection.changeConnectStatus(Status.CONNFAIL, 'giving-up');
    }
  }

  /**
   *  function to process a request in the queue.
   *
   *  This function takes requests off the queue and sends them and
   *  restarts dead requests.
   *
   *  Parameters:
   *    (Integer) i - The index of the request in the queue.
   */
  _processRequest(i: number) {
    let req = this._requests[i];
    const reqStatus = Bosh._getRequestStatus(req, -1);

    // make sure we limit the number of retries
    if (req.sends > this.connection.maxRetries) {
      this.connection._onDisconnectTimeout();
      return;
    }
    const time_elapsed = req.age();
    const primary_timeout = !isNaN(time_elapsed) && time_elapsed > Math.floor(TIMEOUT * this.wait);
    const secondary_timeout = req.dead !== null && req.timeDead > Math.floor(SECONDARY_TIMEOUT * this.wait);
    const server_error = req.xhr.readyState === 4 && (reqStatus < 1 || reqStatus >= 500);

    if (primary_timeout || secondary_timeout || server_error) {
      if (secondary_timeout) {
        error(`Request ${this._requests[i].id} timed out (secondary), restarting`);
      }
      req.abort = true;
      req.xhr.abort();
      // setting to null fails on IE6, so set to empty function
      req.xhr.onreadystatechange = () => {};
      this._requests[i] = new Request(req.xmlData, req.origFunc, req.rid, req.sends);
      req = this._requests[i];
    }

    if (req.xhr.readyState === 0) {
      debug('request id ' + req.id + '.' + req.sends + ' posting');

      try {
        const content_type = this.connection.options.contentType || 'text/xml; charset=utf-8';
        req.xhr.open('POST', this.connection.service, !this.connection.options.sync);
        if (typeof req.xhr.setRequestHeader !== 'undefined') {
          // IE9 doesn't have setRequestHeader
          req.xhr.setRequestHeader('Content-Type', content_type);
        }
        if (this.connection.options.withCredentials) {
          req.xhr.withCredentials = true;
        }
      } catch (e2) {
        error('XHR open failed: ' + e2.toString());
        if (!this.connection.connected) {
          this.connection.changeConnectStatus(Status.CONNFAIL, 'bad-service');
        }
        this.connection.disconnect();
        return;
      }

      // Fires the XHR request -- may be invoked immediately
      // or on a gradually expanding retry window for reconnects
      const sendFunc = () => {
        req.date = new Date();
        if (this.connection.options.customHeaders) {
          const headers = this.connection.options.customHeaders;
          for (const header in headers) {
            if (Object.prototype.hasOwnProperty.call(headers, header)) {
              req.xhr.setRequestHeader(header, headers[header]);
            }
          }
        }
        req.xhr.send(req.data);
      };

      // Implement progressive backoff for reconnects --
      // First retry (send === 1) should also be instantaneous
      if (req.sends > 1) {
        // Using a cube of the retry number creates a nicely
        // expanding retry window
        const backoff = Math.min(Math.floor(TIMEOUT * this.wait), Math.pow(req.sends, 3)) * 1000;
        setTimeout(function () {
          // XXX: setTimeout should be called only with function expressions (23974bc1)
          sendFunc();
        }, backoff);
      } else {
        sendFunc();
      }

      req.sends++;

      if (req.xmlData.nodeName === this.strip && req.xmlData.childNodes.length) {
        this.connection.xmlOutput(req.xmlData.childNodes[0]);
      } else {
        this.connection.xmlOutput(req.xmlData);
      }
    } else {
      debug('_processRequest: ' + (i === 0 ? 'first' : 'second') + ' request has readyState of ' + req.xhr.readyState);
    }
  }

  /**
   *  function to remove a request from the queue.
   *
   *  Parameters:
   *    (Strophe.Request) req - The request to remove.
   */
  _removeRequest(req: Request) {
    debug('removing request');
    for (let i = this._requests.length - 1; i >= 0; i--) {
      if (req === this._requests[i]) {
        this._requests.splice(i, 1);
      }
    }
    // IE6 fails on setting to null, so set to empty function
    req.xhr.onreadystatechange = () => {};
    this._throttledRequestHandler();
  }

  /**
   *  function to restart a request that is presumed dead.
   *
   *  Parameters:
   *    (Integer) i - The index of the request in the queue.
   */
  _restartRequest(i: number) {
    const req = this._requests[i];
    if (req.dead === null) {
      req.dead = new Date();
    }
    this._processRequest(i);
  }

  /**
   function to get a stanza out of a request.
   *
   * Tries to extract a stanza out of a Request Object.
   * When this fails the current connection will be disconnected.
   *
   *  Parameters:
   *    (Object) req - The Request.
   *
   *  Returns:
   *    The stanza that was passed.
   */
  reqToData(req: Request): Element {
    try {
      return req.getResponse();
    } catch (e) {
      if (e.message !== 'parsererror') {
        throw e;
      }
      this.connection.disconnect('strophe-parsererror');
    }
    return null;
  }

  /**
   *  function to send initial disconnect sequence.
   *
   *  This is the first step in a graceful disconnect.  It sends
   *  the BOSH server a terminated body and includes an unavailable
   *  presence if authentication has completed.
   */
  _sendTerminate(pres: Element) {
    debug('_sendTerminate was called');
    const body = this._buildBody().attrs({ type: 'terminate' });
    if (pres) {
      body.cnode(pres);
    }
    const req = new Request(
      body.tree(),
      this._onRequestStateChange.bind(this, this.connection._dataRecv.bind(this.connection)),
      Number.parseInt(body.tree().getAttribute('rid'), 10)
    );
    this._requests.push(req);
    this._throttledRequestHandler();
  }

  /**
   *  part of the Connection.send function for BOSH
   *
   * Just triggers the RequestHandler to send the messages that are in the queue
   */
  send() {
    clearTimeout(this.connection.idleTimeout);
    this._throttledRequestHandler();
    // @ts-ignore
    this.connection.idleTimeout = setTimeout(() => this.connection._onIdle(), 100);
  }

  /**
   *
   *  Send an xmpp:restart stanza.
   */
  sendRestart() {
    this._throttledRequestHandler();
    clearTimeout(this.connection.idleTimeout);
  }

  /**
   *  function to throttle requests to the connection window.
   *
   *  This function makes sure we don't send requests so fast that the
   *  request ids overflow the connection window in the case that one
   *  request died.
   */
  _throttledRequestHandler() {
    if (!this._requests) {
      debug('_throttledRequestHandler called with ' + 'undefined requests');
    } else {
      debug('_throttledRequestHandler called with ' + this._requests.length + ' requests');
    }

    if (!this._requests || this._requests.length === 0) {
      return;
    }

    if (this._requests.length > 0) {
      this._processRequest(0);
    }

    if (this._requests.length > 1 && Math.abs(this._requests[0].rid - this._requests[1].rid) < this.limit) {
      this._processRequest(1);
    }
  }

  restoreBOSHSession(): boolean {
    const jid = this.initBOSHSession();
    try {
      this.restore(jid, async (status, condition) => this.connection.onConnectStatusChanged(status, condition));
      return true;
    } catch (e) {}
    return false;
  }

  initBOSHSession(): string {
    // new session from connection, this.jid keepalive
    const jid = this.connection.jid ?? this.jid;
    this.jid = this.connection.setUserJID(jid);
    return this.jid;
  }

  startNewPreboundBOSHSession(): void {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', this.prebindUrl, true);
    xhr.setRequestHeader('Accept', 'application/json, text/javascript');
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 400) {
        const data = JSON.parse(xhr.responseText);
        const jid = this.connection.setUserJID(data.jid);
        (this.connection as Connection).attach(jid, data.sid, data.rid, this.connection.onConnectStatusChanged.bind(this), 59);
      } else {
        xhr.onerror(null);
      }
    };
    xhr.onerror = () => {
      this.connection.killSessionBosh();
      this.destroySubject.next();
      /**
       * Triggered when fetching prebind tokens failed
       */
      this.noResumeableBOSHSessionSubject.next();
    };
    xhr.send();
  }
}
