import RAPIER from '../vendor/rapier/rapier.mjs';

export async function createCDPhysics(radius = 1.8, hole = .225, thickness = .036) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: -32 });
  world.timestep = 1 / 120;
  const ground = RAPIER.ColliderDesc.cuboid(1000, 1000, .1)
    .setTranslation(0, 0, -.12).setFriction(.55).setRestitution(.12);
  world.createCollider(ground);
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, 0, 3).setCcdEnabled(true)
    .setLinearDamping(.08).setAngularDamping(.08)
    .setAdditionalSolverIterations(8));
  // Rapier cylinders run along Y; the CD's face normal is Z.
  world.createCollider(RAPIER.ColliderDesc.cylinder(thickness / 2, radius)
    .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 })
    .setMass(.016).setFriction(.55).setRestitution(.12).setContactSkin(.001), body);
  return { world, body, RAPIER };
}
