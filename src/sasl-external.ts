import { SASLMechanismBase } from './sasl';
import { Connection } from './connection';

export class SASLExternal extends SASLMechanismBase {
  /**
   *  SASL EXTERNAL authentication.
   *
   *  The EXTERNAL mechanism allows a client to request the server to use
   *  credentials established by means external to the mechanism to
   *  authenticate the client. The external means may be, for instance,
   *  TLS services.
   */
  constructor() {
    super('EXTERNAL', true, 10);
  }

  test(_connection: Connection): boolean {
    return true;
  }

  async onChallenge(connection: Connection): Promise<string> {
    /** According to XEP-178, an authzid SHOULD NOT be presented when the
     * authcid contained or implied in the client certificate is the JID (i.e.
     * authzid) with which the user wants to log in as.
     *
     * To NOT send the authzid, the user should therefore set the authcid equal
     * to the JID when instantiating a new Strophe.Connection object.
     */
    return connection.authcid === connection.authzid ? '' : connection.authzid;
  }
}
