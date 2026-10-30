/// <reference types="vite/client" />

declare interface Window {
  __INITIAL_STATE__?: any;
  electronAPI?: {
    isElectron: boolean;
    isPackaged: boolean;
    platform: string;
    api: {
      /** 业务 / 账号接口；token 由主进程 authenticate，返回 { status, data } */
      request(pathname: string, body?: any, token?: string): Promise<{ status: number; data: any }>;
      uploadFile(sessionId: string, fileName: string, fileData: ArrayBuffer | Uint8Array, token?: string): Promise<{ success: boolean; bytes?: number; fileName?: string; error?: string }>;
      getCwd(sessionId: string, zmodem?: boolean, force?: boolean, token?: string): Promise<{ cwd?: string; reliable?: boolean; error?: string }>;
      downloadFile(sessionId: string, remotePath: string, fileName?: string, token?: string): Promise<{ success: boolean; canceled?: boolean; filePath?: string; size?: number; error?: string }>;
    };

    /** 远程文件信息（文件管理面板） */
    fileInfo?: {
      name: string;
      path: string;
      size: number;
      mtime: number;
      atime: number;
      isDirectory: boolean;
      isFile: boolean;
      isSymbolicLink: boolean;
      mode: number;
      permissions: string;
      owner: string;
      group: string;
    };
    clipboard: {
      writeText(text: string): void;
      readText(): string;
    };
    terminalIPC: {
      send(message: any): void;
      onMessage(callback: (msg: any) => void): () => void;
    };
    updater?: {
      checkForUpdates(): Promise<any>;
      getStatus(): Promise<{ updateAvailable: { version: string; releaseDate: string } | null; updateDownloaded: boolean; downloadProgress: { percent: number } | null }>;
      install(): Promise<any>;
      onEvent(callback: (msg: { event: string; data: any }) => void): () => void;
      onMenuAction(callback: (action: string) => void): () => void;
    };
  };
}
