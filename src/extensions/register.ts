import { log, LogLevel } from '../log';
import { SASLMechanism } from '../sasl-mechanism';
import { Status } from '../status';
import { $iq } from '../builder-helper';
import { Connection } from '../connection';
import { BoshRequest } from '../bosh-request';
import { Bosh } from '../bosh';
import { StropheWebsocket } from '../strophe-websocket';

/**
 * Promise resolves if user account is registered successfully,
 * rejects if an error happens while registering, e.g. the username is already taken.
 */
export async function register(
  username: string,
  password: string,
  service: string,
  domain: string
): Promise<void> {
  const nsRegister = 'jabber:iq:register';

  let registering = false;
  let processedFeatures = false;

  if (username.includes('@')) {
    log(
      LogLevel.WARN,
      'username should not contain domain, only local part, this can lead to errors!'
    );
  }

  const conn = await Connection.create(service, domain);
  await conn.logOut();

  const readyToStartRegistration = createRegistrationPromise(
    conn,
    () => processedFeatures,
    () => registering,
    username,
    domain,
    password
  );

  // anonymous connection
  await conn.connect(domain);

  registering = true;
  await readyToStartRegistration;

  await queryForRegistrationForm(conn, nsRegister);
  await submitRegisterInformationQuery(conn, username, password, nsRegister);

  registering = false;
  processedFeatures = true;
  // here we should have switched after processing the feature's stanza to the regular callback after login
  conn.reset();
  await conn.logOut();
  await conn.loginWithoutJid(username, domain, password);
}

function createRegistrationPromise(
  conn: Connection,
  processedFeatures: () => boolean,
  registering: () => boolean,
  username: string,
  domain: string,
  password: string
): Promise<void> {
  if (conn.protocolManager instanceof Bosh) {
    const connectCallbackData: { boshRequest: BoshRequest } = { boshRequest: null };
    const bosh = conn.protocolManager;
    return new Promise<void>((resolve) => {
      const originalConnectCallback = (innerBosh: Bosh, req: BoshRequest): void =>
        conn.connectCallbackBosh(bosh, req);
      conn.connectCallbackBosh = async (innerBosh: Bosh, req) => {
        if (registering()) {
          // Save this request in case we want to authenticate later
          connectCallbackData.boshRequest = req;
          resolve();
          return;
        }

        if (processedFeatures()) {
          // exchange Input hooks to not print the stream:features twice
          const xmlInput = (el: Element): void => conn.xmlInput(el);
          await originalConnectCallback(innerBosh, req);
          conn.xmlInput = xmlInput;
        }

        await originalConnectCallback(innerBosh, req);
      };

      // hooking strophe`s authenticate
      const authOld = async (matched: SASLMechanism[]): Promise<void> => conn.authenticate(matched);
      conn.authenticate = async (matched: SASLMechanism[]): Promise<void> => {
        if (matched) {
          await authOld(matched);
          return;
        }

        if (!username || !domain || !password) {
          return;
        }

        conn.sasl.setVariables(username + '@' + domain, password);

        await conn.connectCallbackBosh(bosh, connectCallbackData.boshRequest);
      };
    });
  }
  if (conn.protocolManager instanceof StropheWebsocket) {
    const connectCallbackData: { element: Element } = { element: null };
    const websocket = conn.protocolManager;
    return new Promise<void>((resolve) => {
      const originalConnectCallback = (
        innerWebsocket: StropheWebsocket,
        req: Element
      ): Promise<void> => conn.connectCallbackWebsocket(innerWebsocket, req);
      conn.connectCallbackWebsocket = async (innerWebsocket: StropheWebsocket, req: Element) => {
        if (registering()) {
          // Save this request in case we want to authenticate later
          connectCallbackData.element = req;
          resolve();
          return;
        }

        if (processedFeatures()) {
          // exchange Input hooks to not print the stream:features twice
          const xmlInput = (el: Element): void => conn.xmlInput(el);
          await originalConnectCallback(innerWebsocket, req);
          conn.xmlInput = xmlInput;
        }

        await originalConnectCallback(innerWebsocket, req);
      };

      // hooking strophe`s authenticate
      const authOld = async (matched: SASLMechanism[]): Promise<void> => conn.authenticate(matched);
      conn.authenticate = async (matched: SASLMechanism[]): Promise<void> => {
        if (matched) {
          await authOld(matched);
          return;
        }

        if (!username || !domain || !password) {
          return;
        }

        conn.sasl.setVariables(username + '@' + domain, password);

        await conn.connectCallbackWebsocket(websocket, connectCallbackData.element);
      };
    });
  }
  return Promise.resolve();
}

async function queryForRegistrationForm(conn: Connection, nsRegister: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // send a get request for registration, to get all required data fields
    conn.handlerService.addSysHandler(
      (stanza) => {
        const query = stanza.getElementsByTagName('query');
        if (query.length !== 1) {
          conn.changeConnectStatus(Status.REGIFAIL, 'unknown');
          reject('registration failed by unknown reason');
          return false;
        }

        conn.changeConnectStatus(Status.REGISTER, null);

        resolve();
        return false;
      },
      null,
      'iq',
      null,
      null
    );

    conn.sendIQ($iq({ type: 'get' }).c('query', { xmlns: nsRegister }).tree());
  });
}

async function submitRegisterInformationQuery(
  conn: Connection,
  username: string,
  password: string,
  nsRegister: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    conn.handlerService.addSysHandler(
      (stanza) => {
        let error = null;

        if (stanza.getAttribute('type') === 'error') {
          error = stanza.getElementsByTagName('error');
          if (error.length !== 1) {
            conn.changeConnectStatus(Status.REGIFAIL, 'unknown');
            reject();
            return false;
          }

          // this is either 'conflict' or 'not-acceptable'
          error = error[0].firstChild.nodeName.toLowerCase();
          if (error === 'conflict') {
            conn.changeConnectStatus(Status.CONFLICT, error);
            reject();
          } else if (error === 'not-acceptable') {
            conn.changeConnectStatus(Status.NOTACCEPTABLE, error);
            reject();
          } else {
            conn.changeConnectStatus(Status.REGIFAIL, error);
            reject();
          }
        } else {
          conn.changeConnectStatus(Status.REGISTERED, null);
          resolve();
        }

        return false; // makes strophe delete the sysHandler
      },
      null,
      'iq',
      null,
      null
    );

    conn.sendIQ(
      $iq({ type: 'set' })
        .c('query', { xmlns: nsRegister })
        .c('username', {}, username)
        .c('password', {}, password)
    );
  });
}
