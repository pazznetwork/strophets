import { AuthenticationMode } from './authentication-mode';

export interface ConnectionSettings {
  discoverConnectionMethods: boolean;
  authenticationMode: AuthenticationMode;
  clearCacheOnLogout: boolean;
  automaticLogin: boolean;
  password: string;
  credentialsUrl: string;
  prebindUrl: string;
}
