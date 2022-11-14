import { Connection } from './connection';
import { NS } from './namespace';
import { BoshRequest } from './bosh-request';
import { $build } from './builder-helper';
import { getBareJidFromJid, getDomainFromJid, getNodeFromJid } from './xml';
import { debug, error, warn } from './log';
import { Status } from './status';
import { SECONDARY_TIMEOUT, TIMEOUT } from './timeout';
import { ProtocolManager } from './protocol-manager';
import { Subject, takeUntil } from 'rxjs';
import { Builder } from './builder';

/**
 *  The Bosh class is used internally by the Connection class to encapsulate BOSH sessions.
 */
export class Bosh implements ProtocolManager {
  /***
   * First request id for XML request elements.
   * The rid will be incremented with each request until the connection resets.
   * An incrementation range check is used to ensure a limit of parallel requests.
   */
  rid = this.getRandomIdForConnection();
  private sid: string = null;

  /**
   * This is the time the server will wait before returning an empty result for a request.
   * The default setting of 60 seconds is recommended.
   */
  wait = 60;

  /**
   * This is the amount of allowed parallel request being processed. The default is 5.
   */
  limit = 5;
  private lastResponseHeaders: string;
  //TODO: there are in general only 2 requests should be refactored into a tupel or two request properties
  private readonly requests: BoshRequest[];

  private destroySubject = new Subject<void>();
  private readonly notAbleToResumeBOSHSessionSubject = new Subject<void>();
  notAbleToResumeBOSHSession$ = this.notAbleToResumeBOSHSessionSubject.asObservable();

  jid: string;

  get primaryTimeout(): number {
    return Math.floor(TIMEOUT * this.wait);
  }

  get secondaryTimeout(): number {
    return Math.floor(SECONDARY_TIMEOUT * this.wait);
  }

  /**
   *  Create and initialize a Strophe.Bosh object.
   *
   *  Parameters:
   *
   *    @param connection connection - The Strophe.Connection that will use BOSH.
   *    @param prebindUrl
   */
  constructor(readonly connection: Connection, private readonly prebindUrl?: string) {
    this.connection.userJid$
      .pipe(takeUntil(this.destroySubject))
      .subscribe((newJid) => (this.jid = newJid));

    /* The current session ID. */
    this.sid = null;

    this.lastResponseHeaders = null;
    this.requests = [];
  }

  getRandomIdForConnection(): number {
    return Math.floor(Math.random() * 4294967295);
  }

  /**
   *  function that initializes the BOSH connection.
   *
   *  Creates and sends the Request that initializes the BOSH connection.
   *  No Route:Design:1.1
   */
  connect(): void {
    const body = this.buildBody().attrs({
      to: this.connection.domain,
      'xml:lang': 'en',
      wait: this.wait.toString(10),
      hold: '1',
      content: 'text/xml; charset=utf-8',
      ver: '1.6',
      'xmpp:version': '1.0',
      'xmlns:xmpp': NS.BOSH,
    });

    this.requests.push(
      new BoshRequest(
        body.tree(),
        (req) =>
          this.onRequestStateChange(
            (requestElement) => this.connection.connectCallback(requestElement.xmlData),
            req
          ),
        Number.parseInt(body.tree().getAttribute('rid'), 10)
      )
    );
    this.throttledRequestHandler();
  }

  /**
   *  helper function to generate the <body/> wrapper for BOSH.
   *
   *  @returns  A Builder containing a <body/> element.
   */
  buildBody(): Builder {
    const bodyWrap = $build('body', {
      rid: (this.rid++).toString(),
      xmlns: NS.HTTPBIND,
    });
    if (this.sid != null) {
      bodyWrap.attrs({ sid: this.sid });
    }
    if (this.connection.options.keepalive) {
      if (this.connection.authenticated) {
        if (this.connection.jid && this.rid && this.sid) {
          window.sessionStorage.setItem(
            'strophe-bosh-session',
            JSON.stringify({
              jid: this.connection.jid,
              rid: this.rid,
              sid: this.sid,
            })
          );
        }
      } else {
        window.sessionStorage.removeItem('strophe-bosh-session');
      }
    }
    return bodyWrap;
  }

  /**
   *  Reset the connection.
   *
   *  This function is called by the reset function of the Strophe Connection
   */
  reset(): void {
    this.rid = this.getRandomIdForConnection();
    this.sid = null;
    globalThis.sessionStorage.removeItem('strophe-bosh-session');
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
   */
  attach(
    jid: string,
    sid: string,
    rid: number,
    callback: (status: number, condition: string) => Promise<void>
  ): void {
    this.connection.jid = jid;
    this.sid = sid;
    this.rid = rid;

    this.connection.callback = callback;
    this.connection.domain = getDomainFromJid(this.connection.jid);
    this.connection.authenticated = true;
    this.connection.connected = true;

    this.connection.changeConnectStatus(Status.ATTACHED, null);
  }

  /**
   *  Attempt to restore a cached BOSH session
   *
   *   @param jid - The full JID that is bound by the session.
   *      This parameter is optional but recommended, specifically in cases
   *      where prebinded BOSH sessions are used where it's important to know
   *      that the right session is being restored.
   *   @param callback function.
   */
  restore(jid: string, callback: (status: number, condition: string) => Promise<void>): void {
    const session = JSON.parse(window.sessionStorage.getItem('strophe-bosh-session'));
    if (
      session != null &&
      session.rid &&
      session.sid &&
      session.jid &&
      (jid == null ||
        getBareJidFromJid(session.jid) === getBareJidFromJid(jid) ||
        // If authcid is null, then it's an anonymous login, so
        // we compare only the domains:
        (getNodeFromJid(jid) == null && getDomainFromJid(session.jid) === jid))
    ) {
      this.attach(session.jid, session.sid, session.rid, callback);
    } else {
      throw new Error('restore: no session that can be restored.');
    }
  }

  /**
   *  This handler is used to process the Bosh-part of the initial request.
   *
   *   @param bodyWrap - The received stanza.
   *
   *   @returns Status
   */
  connectCb(bodyWrap: Element): Status.CONNECTED | Status.CONNFAIL {
    if (bodyWrap.getAttribute('type') !== 'terminate') {
      return Status.CONNECTED;
    }

    // an error occurred
    const cond = bodyWrap.getAttribute('condition');
    error('BOSH-Connection failed: ' + cond);
    this.connection.changeConnectStatus(Status.CONNFAIL, cond ?? 'unknown');
    this.connection.doDisconnect(cond);
    return Status.CONNFAIL;
  }

  /**
   *  part of disconnect for Bosh
   *
   *   @param pres - This stanza will be sent before disconnecting.
   */
  disconnect(pres: Element): void {
    this.sendTerminate(pres);
  }

  /**
   *  function to disconnect.
   *
   *  Resets the SID and RID.
   */
  doDisconnect(): void {
    this.sid = null;
    this.rid = this.getRandomIdForConnection();
    globalThis.sessionStorage.removeItem('strophe-bosh-session');
  }

  /**
   * function to check if the Request queue is empty.
   *
   *  @returns true, if there are no Requests queued, False otherwise.
   */
  emptyQueue(): boolean {
    return this.requests.length === 0;
  }

  /**
   * Called on stream start/restart when no stream:features
   * has been received and sends a blank poll request.
   */
  noAuthReceived(): void {
    warn(
      'Server did not yet offer a supported authentication ' +
        'mechanism. Sending a blank poll request.'
    );
    const body = this.buildBody();
    const rid = Number.parseInt(body.tree().getAttribute('rid'), 10);
    this.requests.push(
      new BoshRequest(body.tree(), (req) => this.connection.connectCallback(req.xmlData), rid)
    );
    this.throttledRequestHandler();
  }

  /**
   *  timeout handler for handling non-graceful disconnection.
   *
   *  Cancels all remaining Requests and clears the queue.
   */
  onDisconnectTimeout(): void {
    this.abortAllRequests();
  }

  /**
   *  helper function that makes sure all pending requests are aborted.
   */
  abortAllRequests(): void {
    while (this.requests.length > 0) {
      const req = this.requests.pop();
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
  onIdle(): void {
    const data = this.connection.data;
    // if no requests are in progress, poll
    if (
      this.connection.authenticated &&
      this.requests.length === 0 &&
      data.length === 0 &&
      !this.connection.disconnecting
    ) {
      debug('no requests during idle cycle, sending blank request');
      data.push(null);
    }

    if (this.connection.paused) {
      return;
    }

    if (this.requests.length < 2 && data.length > 0) {
      const body = this.buildBody();
      for (const dataPart of data) {
        if (dataPart !== null && dataPart.tagName !== 'restart') {
          body.cnode(dataPart).up();
          continue;
        }
        body.attrs({
          to: this.connection.domain,
          'xml:lang': 'en',
          'xmpp:restart': 'true',
          'xmlns:xmpp': NS.BOSH,
        });
      }
      delete this.connection.data;
      this.connection.data = [];
      this.requests.push(
        new BoshRequest(
          body.tree(),
          this.onRequestStateChange.bind(this, this.connection.dataReceived.bind(this.connection)),
          Number.parseInt(body.tree().getAttribute('rid'), 10)
        )
      );
      this.throttledRequestHandler();
    }

    if (this.requests.length > 0) {
      const firstReq = this.requests[0];
      if (firstReq.dead && firstReq.timeDead > this.secondaryTimeout) {
        this.throttledRequestHandler();
      }
      if (firstReq.age > this.primaryTimeout) {
        warn(
          'Request ' +
            firstReq.rid +
            ' timed out, over ' +
            this.primaryTimeout +
            ' seconds since last activity'
        );
        this.throttledRequestHandler();
      }
    }
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
   *
   *    @param func - The handler for the request.
   *    @param req - The request that is changing readyState.
   */
  onRequestStateChange(func: (req: BoshRequest) => void, req: BoshRequest): void {
    debug('request id ' + req.rid + '.' + req.sends + ' state changed to ' + req.xhr.readyState);
    if (req.abort) {
      req.abort = false;
      return;
    }
    if (req.xhr.readyState !== 4) {
      // The request is not yet complete
      return;
    }
    const reqStatus = req.getRequestStatus();
    this.lastResponseHeaders = req.xhr.getAllResponseHeaders();
    if (this.connection.disconnecting && reqStatus >= 400) {
      // TODO: Check if hit error is necessary, error count for escalating error was 5
      return;
    }

    const reqIs0 = this.requests[0] === req;
    const reqIs1 = this.requests[1] === req;

    const valid_request = reqStatus > 0 && reqStatus < 500;
    const too_many_retries = req.sends > this.connection.maxRetries;
    if (valid_request || too_many_retries) {
      // remove from internal queue
      this.removeRequest(req);
      debug('request id ' + req.rid + ' should now be removed');
    }

    if (reqStatus === 200) {
      // request succeeded
      // if request 1 finished, or request 0 finished and request
      // 1 is over SECONDARY_TIMEOUT seconds old, we need to
      // restart the other - both will be in the first spot, as the
      // completed request has been removed from the queue already
      if (
        reqIs1 ||
        (reqIs0 &&
          this.requests.length > 0 &&
          this.requests[0].age > Math.floor(SECONDARY_TIMEOUT * this.wait))
      ) {
        this.restartRequest(0);
      }
      debug('request id ' + req.rid + '.' + req.sends + ' got 200');
      func(req); // call handler
    } else if (reqStatus === 0 || (reqStatus >= 400 && reqStatus < 600)) {
      // request failed
      error('request id ' + req.rid + '.' + req.sends + ' error ' + reqStatus + ' happened');
      // TODO: Check if hit error is necessary, error count for escalating error was 5
      if (reqStatus >= 400 && reqStatus < 500) {
        this.connection.changeConnectStatus(Status.DISCONNECTING, null);
        this.connection.doDisconnect();
      }
    } else {
      error('request id ' + req.rid + '.' + req.sends + ' error ' + reqStatus + ' happened');
    }

    if (!valid_request && !too_many_retries) {
      this.throttledRequestHandler();
    } else if (too_many_retries && !this.connection.connected) {
      this.connection.changeConnectStatus(Status.CONNFAIL, 'giving-up');
    }
  }

  /**
   *  function to process a request in the queue.
   *
   *  This function takes requests off the queue and sends them and restarts dead requests.
   *
   *  Parameters:
   *
   *   @param i - The index of the request in the queue.
   */
  processRequest(i: number): void {
    // make sure we limit the number of retries
    if (this.requests[i].sends > this.connection.maxRetries) {
      this.connection.onDisconnectTimeout();
      return;
    }

    this.requests[i] = this.ensureAliveRequest(this.requests[i]);

    this.requests[i].process(i, this.connection, this.primaryTimeout);
  }

  private ensureAliveRequest(request: BoshRequest): BoshRequest {
    const reqStatus = request.getRequestStatus();
    const primary_timeout = !isNaN(request.age) && request.age > this.primaryTimeout;
    const secondary_timeout =
      request.dead && request.timeDead > Math.floor(SECONDARY_TIMEOUT * this.wait);
    const server_error = request.xhr.readyState === 4 && (reqStatus < 1 || reqStatus >= 500);

    if (secondary_timeout) {
      error(`Request ${this.rid} timed out (secondary), restarting`);
    }

    if (primary_timeout || secondary_timeout || server_error) {
      request.abort = true;
      request.xhr.abort();
      // setting to null fails on IE6, so set to empty function
      request.xhr.onreadystatechange = () => {};
      const req = new BoshRequest(request.xmlData, request.func, this.rid);
      req.sends = request.sends;
      return req;
    }

    return request;
  }

  /**
   *  function to remove a request from the queue.
   *
   *  Parameters:
   *
   *    @param req - The request to remove.
   */
  removeRequest(req: BoshRequest): void {
    debug('removing request');
    const i = this.requests.indexOf(req);
    if (i === -1) {
      return;
    }
    this.requests.splice(i, 1);

    // IE6 fails on setting to null, so set to empty function
    req.xhr.onreadystatechange = () => {};
    this.throttledRequestHandler();
  }

  /**
   *  function to restart a request that is presumed dead.
   *
   *  Parameters:
   *
   *    @param i - The index of the request in the queue.
   */
  restartRequest(i: number): void {
    const req = this.requests[i];
    req.dead = req.dead ?? new Date().getTime();
    this.processRequest(i);
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
  reqToData(req: BoshRequest): Element {
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
   *  Sends the initial disconnect sequence.
   *
   *  This is the first step in a graceful disconnect.  It sends
   *  the BOSH server a terminated body and includes an unavailable
   *  presence if authentication has completed.
   */
  sendTerminate(pres: Element): void {
    debug('sendTerminate was called');
    const body = this.buildBody().attrs({ type: 'terminate' });
    if (pres) {
      body.cnode(pres);
    }
    const req = new BoshRequest(
      body.tree(),
      this.onRequestStateChange.bind(this, this.connection.dataReceived.bind(this.connection)),
      Number.parseInt(body.tree().getAttribute('rid'), 10)
    );
    this.requests.push(req);
    this.throttledRequestHandler();
  }

  /**
   * Triggers the RequestHandler to send the messages that are in the queue
   */
  send(): void {
    clearTimeout(this.connection.idleTimeout);
    this.throttledRequestHandler();
    this.connection.idleTimeout = setTimeout(() => this.connection.onIdle(), 100);
  }

  /**
   *  Send an xmpp:restart stanza.
   */
  sendRestart(): void {
    this.throttledRequestHandler();
    clearTimeout(this.connection.idleTimeout);
  }

  /**
   *  function to throttle requests to the connection window.
   *
   *  This function makes sure we don't send requests so fast that the
   *  request ids overflow the connection window in the case that one
   *  request died.
   */
  throttledRequestHandler(): void {
    if (!this.requests) {
      debug('_throttledRequestHandler called with ' + 'undefined requests');
    } else {
      debug('_throttledRequestHandler called with ' + this.requests.length + ' requests');
    }

    if (!this.requests || this.requests.length === 0) {
      return;
    }

    if (this.requests.length > 0) {
      this.processRequest(0);
    }

    if (
      this.requests.length > 1 &&
      Math.abs(this.requests[0].rid - this.requests[1].rid) < this.limit
    ) {
      this.processRequest(1);
    }
  }

  restoreBOSHSession(): boolean {
    // new session from connection, this.jid keepalive
    this.connection.jid = this.connection.jid ?? this.jid;
    this.jid = this.connection.jid;
    const jid = this.jid;
    try {
      this.restore(jid, async (status, condition) =>
        this.connection.onConnectStatusChanged(status, condition)
      );
      return true;
    } catch (e) {}
    return false;
  }

  async startNewPreboundBOSHSession(): Promise<void> {
    try {
      const { jid, sid, rid } = await BoshRequest.get<{ jid: string; sid: string; rid: number }>(
        this.prebindUrl
      );
      this.connection.jid = jid;
      this.attach(jid, sid, rid, (status, condition) =>
        this.connection.onConnectStatusChanged(status, condition)
      );
    } catch (e) {
      this.connection.clearSession();
      this.destroySubject.next();
      /**
       * Triggered when fetching prebind tokens failed
       */
      this.notAbleToResumeBOSHSessionSubject.next();
    }
  }
}
