import { SASLMechanismBase } from './sasl';
import { utf16to8 } from './utils';
import { Connection } from './connection';

export class SASLOAuthBearer extends SASLMechanismBase {
  /** PrivateConstructor: SASLOAuthBearer
   *  SASL OAuth Bearer authentication.
   */
  constructor() {
    super('OAUTHBEARER', true, 40);
  }

  test(connection: Connection): boolean {
    return connection.pass !== null;
  }

  async onChallenge(connection: Connection): Promise<string> {
    let auth_str = 'n,';
    if (connection.authcid !== null) {
      auth_str = auth_str + 'a=' + connection.authzid;
    }
    auth_str = auth_str + ',';
    auth_str = auth_str + '\u0001';
    auth_str = auth_str + 'auth=Bearer ';
    auth_str = auth_str + connection.pass;
    auth_str = auth_str + '\u0001';
    auth_str = auth_str + '\u0001';
    return utf16to8(auth_str);
  }
}
