import { Router } from "express";

export interface Extension {
  name: string;
  initialize: (router: Router) => Promise<void> | void;
}

class ExtensionRegistry {
  private extensions: Extension[] = [];

  register(extension: Extension) {
    this.extensions.push(extension);
  }

  async initializeAll(router: Router) {
    if (this.extensions.length === 0) {
      console.info("[Extensions] No extensions to initialize");
      return;
    }

    return Promise.all(
      this.extensions.map((ext) => {
        console.info(`[Extensions] Initializing: ${ext.name}...`);
        return ext.initialize(router);
      })
    );
  }
}

export const registry = new ExtensionRegistry();
