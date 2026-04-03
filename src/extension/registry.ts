import { config } from "@/config.js";
import { Router } from "express";

export interface Extension {
  name: string;
  flags: Set<string>;
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
        const missingFlags = [...ext.flags].filter(
          (flag) => !config.features.has(flag)
        );
        if (missingFlags.length > 0) {
          console.info(
            `[Extensions] Skipping ${ext.name} due to missing required flags: ${missingFlags.join(", ")}`
          );
          return;
        }

        console.info(`[Extensions] Initializing: ${ext.name}...`);
        return ext.initialize(router);
      })
    );
  }
}

export const registry = new ExtensionRegistry();
