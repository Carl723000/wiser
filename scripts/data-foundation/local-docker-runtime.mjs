// Red-phase seam for selecting one local endpoint without changing the user's
// global Docker context. The guards are exercised before startup uses this.
export async function resolveLocalDockerEnvironment(environment, execute) {
  return environment;
}
