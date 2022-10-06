import { SASLMechanismBase } from './sasl.js';
import { Connection } from './connection';
import { utf16to8 } from './utils';

export class SASLXOAuth2 extends SASLMechanismBase {
  /** PrivateConstructor: SASLXOAuth2
   *  SASL X-OAuth2 authentication.
   */
  constructor() {
    super('X-OAUTH2', true, 30);
  }

  test(connection: Connection): boolean {
    return connection.pass !== null;
  }

  async onChallenge(connection: Connection): Promise<string> {
    let auth_str = '\u0000';
    if (connection.authcid !== null) {
      auth_str = auth_str + connection.authzid;
    }
    auth_str = auth_str + '\u0000';
    auth_str = auth_str + connection.pass;
    return utf16to8(auth_str);
  }
}
