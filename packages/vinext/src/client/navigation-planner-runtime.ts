type NavigationPlannerModule = typeof import("../server/navigation-planner.js");

let navigationPlannerModule: NavigationPlannerModule | null = null;
let navigationPlannerModuleLoad: Promise<NavigationPlannerModule> | null = null;

export function getClientNavigationPlannerModule(): NavigationPlannerModule {
  if (navigationPlannerModule === null) {
    throw new Error("[vinext] Client navigation planner was used before it was loaded");
  }
  return navigationPlannerModule;
}

export function isClientNavigationPlannerModuleLoaded(): boolean {
  return navigationPlannerModule !== null;
}

export function loadClientNavigationPlannerModule(): Promise<NavigationPlannerModule> {
  if (navigationPlannerModule !== null) return Promise.resolve(navigationPlannerModule);
  if (navigationPlannerModuleLoad !== null) return navigationPlannerModuleLoad;

  navigationPlannerModuleLoad = import("../server/navigation-planner.js")
    .then((module) => {
      navigationPlannerModule = module;
      return module;
    })
    .catch((error: unknown) => {
      navigationPlannerModuleLoad = null;
      throw error;
    });
  return navigationPlannerModuleLoad;
}
