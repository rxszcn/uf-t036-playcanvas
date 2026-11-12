import { expect } from 'chai';

import { INTERPOLATION_LINEAR } from '../../../../src/framework/anim/constants.js';
import { ANIM_LAYER_ADDITIVE, ANIM_LAYER_OVERWRITE } from '../../../../src/framework/anim/controller/constants.js';
import { AnimCurve } from '../../../../src/framework/anim/evaluator/anim-curve.js';
import { AnimData } from '../../../../src/framework/anim/evaluator/anim-data.js';
import { AnimEvents } from '../../../../src/framework/anim/evaluator/anim-events.js';
import { AnimTrack } from '../../../../src/framework/anim/evaluator/anim-track.js';
import { Entity } from '../../../../src/framework/entity.js';
import { MeshInstance } from '../../../../src/scene/mesh-instance.js';
import { Mesh } from '../../../../src/scene/mesh.js';
import { MorphInstance } from '../../../../src/scene/morph-instance.js';
import { MorphTarget } from '../../../../src/scene/morph-target.js';
import { Morph } from '../../../../src/scene/morph.js';
import { createApp } from '../../../app.mjs';
import { jsdomSetup, jsdomTeardown } from '../../../jsdom.mjs';

describe('AnimComponent', function () {

    let app;

    beforeEach(function () {
        jsdomSetup();
        app = createApp();
    });

    afterEach(function () {
        app.destroy();
        app = null;
        jsdomTeardown();
    });

    const track = name => new AnimTrack(name, 1, [], [], []);

    describe('#clone', function () {

        // Regression test for https://github.com/playcanvas/engine/issues/6395
        it('clones a component with a layer added dynamically after the base layer', function () {
            const entity = new Entity('model', app);
            app.root.addChild(entity);
            entity.addComponent('anim', { activate: true });

            // base layer, created implicitly by the first assignAnimation call
            entity.anim.assignAnimation('Idle', track('Idle'));
            entity.anim.assignAnimation('Walk', track('Walk'));

            // second layer added dynamically with an additive blend type
            const upperBody = entity.anim.addLayer('UpperBody', 0.5, null, ANIM_LAYER_ADDITIVE);
            upperBody.assignAnimation('Eager', track('Eager'));
            upperBody.assignAnimation('Dance', track('Dance'));

            let clone;
            expect(() => {
                clone = entity.clone();
            }).to.not.throw();
            app.root.addChild(clone);

            // both layers are reproduced on the clone
            expect(clone.anim.layers.length).to.equal(2);
            expect(clone.anim.findLayer('Base')).to.not.equal(null);
            expect(clone.anim.findLayer('UpperBody')).to.not.equal(null);

            // the dynamically-added layer keeps its blend type
            expect(clone.anim.findLayer('Base').blendType).to.equal(ANIM_LAYER_OVERWRITE);
            expect(clone.anim.findLayer('UpperBody').blendType).to.equal(ANIM_LAYER_ADDITIVE);

            // states (and their assigned animations) are reproduced on both layers
            expect(clone.anim.findLayer('Base').states).to.have.members(['START', 'Idle', 'Walk']);
            expect(clone.anim.findLayer('UpperBody').states).to.have.members(['START', 'Eager', 'Dance']);
            expect(clone.anim.playable).to.equal(true);

            // the clone owns independent layer instances
            expect(clone.anim.layers[1]).to.not.equal(entity.anim.layers[1]);
        });

        it('clones a single-layer component', function () {
            const entity = new Entity('model', app);
            app.root.addChild(entity);
            entity.addComponent('anim', { activate: true });
            entity.anim.assignAnimation('Idle', track('Idle'));

            let clone;
            expect(() => {
                clone = entity.clone();
            }).to.not.throw();

            expect(clone.anim.layers.length).to.equal(1);
            expect(clone.anim.findLayer('Base').states).to.have.members(['START', 'Idle']);
            expect(clone.anim.playable).to.equal(true);
        });
    });

    describe('#findLayer', function () {

        it('returns the named layer, or null when there is none', function () {
            const entity = new Entity('model', app);
            app.root.addChild(entity);
            entity.addComponent('anim', { activate: true });
            const upperBody = entity.anim.addLayer('UpperBody');

            expect(entity.anim.findLayer('UpperBody')).to.equal(upperBody);
            expect(entity.anim.findLayer('Missing')).to.equal(null);
        });

        it('forwards the deprecated findAnimationLayer to findLayer', function () {
            const entity = new Entity('model', app);
            app.root.addChild(entity);
            entity.addComponent('anim', { activate: true });
            const upperBody = entity.anim.addLayer('UpperBody');

            expect(entity.anim.findAnimationLayer('UpperBody')).to.equal(upperBody);
        });

    });

    describe('morph target weights', function () {

        const MORPH_TARGET = 'Blink';

        // mesh instances carrying a single named morph target, as a loaded render asset produces
        const createMeshInstances = (entity) => {
            const mesh = Mesh.fromGeometry(app.graphicsDevice, {
                positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
                indices: [0, 1, 2]
            });
            mesh.morph = new Morph([new MorphTarget({
                name: MORPH_TARGET,
                deltaPositions: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0]),
                defaultWeight: 0
            })], app.graphicsDevice);

            const meshInstance = new MeshInstance(mesh, app.systems.render.defaultMaterial, entity);
            meshInstance.morphInstance = new MorphInstance(mesh.morph);
            return [meshInstance];
        };

        // a track with a single morph weight curve ramping from 0 to 1 over its duration, encoded
        // the way the glb parser encodes them
        const morphTrack = (entityPath) => {
            const curve = new AnimCurve([{
                entityPath,
                component: 'graph',
                propertyPath: [`weight.name.${MORPH_TARGET}`]
            }], 0, 0, INTERPOLATION_LINEAR);

            return new AnimTrack('Morph', 1, [new AnimData(1, [0, 1])], [new AnimData(1, [0, 1])], [curve]);
        };

        const weight = entity => entity.render.meshInstances[0].morphInstance.getWeight(MORPH_TARGET);

        // Regression test for https://github.com/playcanvas/engine/issues/5225
        it('are animated when mesh instances are created after the animation is bound', function () {
            const entity = new Entity('model', app);
            app.root.addChild(entity);

            // a render component whose asset has not loaded yet, so it has no mesh instances
            entity.addComponent('render', { type: 'asset' });
            entity.addComponent('anim', { activate: true });
            entity.anim.assignAnimation('Morph', morphTrack(['model']));

            // frames tick while the asset is still loading - the anim controller binds its curves
            // here, when there is no morph instance to bind the weight curve to
            app.systems.anim.onAnimationUpdate(0.1);

            // the asset arrives and mesh instances are created
            entity.render.meshInstances = createMeshInstances(entity);

            app.systems.anim.onAnimationUpdate(0.4);

            expect(weight(entity)).to.be.closeTo(0.5, 1e-5);
        });

        // Regression test for https://github.com/playcanvas/engine/issues/5225
        it('are animated after mesh instances are replaced', function () {
            const entity = new Entity('model', app);
            app.root.addChild(entity);

            entity.addComponent('render', { type: 'asset' });
            entity.render.meshInstances = createMeshInstances(entity);
            entity.addComponent('anim', { activate: true });
            entity.anim.assignAnimation('Morph', morphTrack(['model']));

            app.systems.anim.onAnimationUpdate(0.5);
            expect(weight(entity)).to.be.closeTo(0.5, 1e-5);

            // an asset unload and reload destroys the morph instances the animation was bound to
            // and creates replacements
            entity.render.destroyMeshInstances();
            entity.render.meshInstances = createMeshInstances(entity);

            // clip time is cumulative, so this samples the track at 0.75
            expect(() => app.systems.anim.onAnimationUpdate(0.25)).to.not.throw();
            expect(weight(entity)).to.be.closeTo(0.75, 1e-5);
        });

        // The layout instantiateRenderEntity produces for an imported character: the anim component
        // on the root, render components on mesh descendants. The binder resolves targets throughout
        // the animated hierarchy, so a descendant's mesh instances must reach the owning component.
        const createHierarchy = (rootBone) => {
            const root = new Entity('root', app);
            const child = new Entity('model', app);
            root.addChild(child);
            app.root.addChild(root);

            child.addComponent('render', { type: 'asset' });
            root.addComponent('anim', { activate: true, rootBone });
            root.anim.assignAnimation('Morph', morphTrack(['root', 'model']));

            return child;
        };

        // Regression test for https://github.com/playcanvas/engine/issues/5225
        it('are animated when a descendant creates mesh instances after the animation is bound', function () {
            const child = createHierarchy();

            app.systems.anim.onAnimationUpdate(0.1);
            child.render.meshInstances = createMeshInstances(child);
            app.systems.anim.onAnimationUpdate(0.4);

            expect(weight(child)).to.be.closeTo(0.5, 1e-5);
        });

        // Regression test for https://github.com/playcanvas/engine/issues/5225
        it('are animated after a descendant replaces its mesh instances', function () {
            const child = createHierarchy();
            child.render.meshInstances = createMeshInstances(child);

            app.systems.anim.onAnimationUpdate(0.5);
            expect(weight(child)).to.be.closeTo(0.5, 1e-5);

            child.render.destroyMeshInstances();
            child.render.meshInstances = createMeshInstances(child);

            expect(() => app.systems.anim.onAnimationUpdate(0.25)).to.not.throw();
            expect(weight(child)).to.be.closeTo(0.75, 1e-5);
        });

        it('are animated when the animated hierarchy is a root bone', function () {
            // the root bone is resolved by guid, so the entity has to be in the scene already
            const root = new Entity('root', app);
            const bones = new Entity('bones', app);
            const child = new Entity('model', app);
            bones.addChild(child);
            root.addChild(bones);
            app.root.addChild(root);

            child.addComponent('render', { type: 'asset' });
            root.addComponent('anim', { activate: true, rootBone: bones });
            root.anim.assignAnimation('Morph', morphTrack(['bones', 'model']));

            app.systems.anim.onAnimationUpdate(0.1);
            child.render.meshInstances = createMeshInstances(child);
            app.systems.anim.onAnimationUpdate(0.4);

            expect(weight(child)).to.be.closeTo(0.5, 1e-5);
        });

        it('are left alone when the changed entity is outside the animated hierarchy', function () {
            const animated = new Entity('animated', app);
            const unrelated = new Entity('unrelated', app);
            app.root.addChild(animated);
            app.root.addChild(unrelated);

            animated.addComponent('anim', { activate: true });
            animated.anim.assignAnimation('Morph', morphTrack(['animated']));
            unrelated.addComponent('render', { type: 'asset' });

            let rebinds = 0;
            const rebind = animated.anim.rebind.bind(animated.anim);
            animated.anim.rebind = () => {
                rebinds++;
                rebind();
            };

            unrelated.render.meshInstances = createMeshInstances(unrelated);

            expect(rebinds).to.equal(0);
        });
    });

    describe('property track binding', function () {

        // a track with a single curve ramping the given property from its first to its second
        // keyframe over the track duration, the way anim clip JSON encodes property curves
        const propertyTrack = (entityPath, component, propertyPath, components, keyframes) => {
            const curve = new AnimCurve([{
                entityPath,
                component,
                propertyPath
            }], 0, 0, INTERPOLATION_LINEAR);

            return new AnimTrack('Property', 1, [new AnimData(1, [0, 1])], [new AnimData(components, keyframes)], [curve]);
        };

        const scaleTrack = entityPath => propertyTrack(entityPath, 'entity', ['localScale'], 3, [1, 1, 1, 3, 3, 3]);

        it('resolves entity paths rooted at the anim component entity', function () {
            const root = new Entity('root', app);
            const child = new Entity('child', app);
            root.addChild(child);
            app.root.addChild(root);

            root.addComponent('anim', { activate: true });
            root.anim.assignAnimation('Scale', scaleTrack(['root', 'child']));

            app.systems.anim.onAnimationUpdate(0.5);

            expect(child.getLocalScale().x).to.be.closeTo(2, 1e-5);
        });

        it('resolves component properties on descendants', function () {
            const root = new Entity('root', app);
            const lamp = new Entity('lamp', app);
            root.addChild(lamp);
            app.root.addChild(root);

            lamp.addComponent('light', { type: 'spot', intensity: 0 });
            root.addComponent('anim', { activate: true });
            root.anim.assignAnimation('Intensity', propertyTrack(['root', 'lamp'], 'light', ['intensity'], 1, [0, 1]));

            app.systems.anim.onAnimationUpdate(0.5);

            expect(lamp.light.intensity).to.be.closeTo(0.5, 1e-5);
        });

        it('binds single element paths to the anim component entity regardless of the root name', function () {
            const root = new Entity('root', app);
            app.root.addChild(root);

            root.addComponent('anim', { activate: true });
            root.anim.assignAnimation('Scale', scaleTrack(['other']));

            app.systems.anim.onAnimationUpdate(0.5);

            expect(root.getLocalScale().x).to.be.closeTo(2, 1e-5);
        });

        it('leaves curves unbound instead of resolving into sibling hierarchies', function () {
            const root = new Entity('root', app);
            const sibling = new Entity('other', app);
            const target = new Entity('target', app);
            sibling.addChild(target);
            app.root.addChild(root);
            app.root.addChild(sibling);

            root.addComponent('anim', { activate: true });
            root.anim.assignAnimation('Scale', scaleTrack(['other', 'target']));

            expect(() => app.systems.anim.onAnimationUpdate(0.5)).to.not.throw();

            expect(target.getLocalScale().x).to.equal(1);
        });

        it('leaves curves unbound when the path names a missing descendant', function () {
            const root = new Entity('root', app);
            app.root.addChild(root);

            root.addComponent('anim', { activate: true });
            root.anim.assignAnimation('Scale', scaleTrack(['root', 'missing']));

            expect(() => app.systems.anim.onAnimationUpdate(0.5)).to.not.throw();
        });
    });

    // A component speed and a state speed each carry a sign, and the effective playback direction
    // is the product of the two. A negative component speed must reverse playback exactly as a
    // negative state speed does, rather than freezing the clips on their first frame.
    describe('playback speed sign', function () {

        const duration = 1;

        // a track ramping localScale.x from 0 to 1 over a second with events at 0.25s and 0.75s
        const speedTrack = () => {
            const curve = new AnimCurve([{
                entityPath: ['root'],
                component: 'entity',
                propertyPath: ['localScale']
            }], 0, 0, INTERPOLATION_LINEAR);
            const animEvents = new AnimEvents([
                { name: 'early', time: 0.25 },
                { name: 'late', time: 0.75 }
            ]);
            return new AnimTrack(
                'Speed',
                duration,
                [new AnimData(1, [0, 1])],
                [new AnimData(3, [0, 0, 0, 1, 1, 1])],
                [curve],
                animEvents
            );
        };

        // builds an anim component whose single state plays the track at stateSpeed, sets the
        // component to componentSpeed and ticks ten 0.1s frames
        const buildComponent = (componentSpeed, stateSpeed, loop = true) => {
            const root = new Entity('root', app);
            app.root.addChild(root);
            root.addComponent('anim', { activate: true });
            root.anim.speed = componentSpeed;
            root.anim.assignAnimation('State', speedTrack(), undefined, stateSpeed, loop);

            const events = [];
            root.anim.on('early', () => events.push('early'));
            root.anim.on('late', () => events.push('late'));

            const scales = [];
            for (let i = 0; i < 10; i++) {
                app.systems.anim.onAnimationUpdate(0.1);
                scales.push(root.getLocalScale().x);
            }

            const layer = root.anim.baseLayer;
            const clip = layer._controller.animEvaluator.clips[0];
            const clipTime = clip.time;
            const clipSpeed = clip.speed;
            const isReverse = clip.isReverse;
            const clipLoop = clip.loop;

            // detach so the component does not keep ticking (and accumulating events) while later
            // components in the same test are driven
            root.destroy();

            return {
                layer,
                clip,
                clipTime,
                clipSpeed,
                isReverse,
                clipLoop,
                events,
                scales
            };
        };

        [
            { componentSpeed: 1, stateSpeed: 1, reverse: false },
            { componentSpeed: -1, stateSpeed: 1, reverse: true },
            { componentSpeed: 1, stateSpeed: -1, reverse: true },
            { componentSpeed: -1, stateSpeed: -1, reverse: false }
        ].forEach(({ componentSpeed, stateSpeed, reverse }) => {
            it(`plays ${reverse ? 'backwards' : 'forwards'} for component speed ${componentSpeed} and state speed ${stateSpeed}`, function () {
                const { clipSpeed, isReverse, scales } = buildComponent(componentSpeed, stateSpeed);

                // the clip speed is the product of the two signs, so both negative-speed entries
                // drive the clip through the same reverse code path
                expect(clipSpeed).to.equal(componentSpeed * stateSpeed);
                expect(isReverse).to.equal(reverse);

                // a frozen-on-first-frame regression would leave every sample at the start value
                const startValue = reverse ? 1 : 0;
                expect(scales[0]).to.be.closeTo(startValue - (reverse ? 0.1 : -0.1), 1e-5);
                const distinct = new Set(scales.map(v => v.toFixed(5)));
                expect(distinct.size).to.be.greaterThan(1);

                // the pose moves monotonically in the playback direction
                for (let i = 1; i < scales.length; i++) {
                    if (reverse) {
                        expect(scales[i]).to.be.at.most(scales[i - 1] + 1e-5);
                    } else {
                        expect(scales[i]).to.be.at.least(scales[i - 1] - 1e-5);
                    }
                }
            });
        });

        it('fires animation events while playing in reverse from a negative component speed', function () {
            const { events } = buildComponent(-1, 1);

            // reverse playback crosses the late (0.75s) event before the early (0.25s) one, and
            // neither event is skipped
            expect(events).to.deep.equal(['late', 'early']);
        });

        it('fires the same events for a negative component speed as for a negative state speed', function () {
            const componentDriven = buildComponent(-1, 1);
            const stateDriven = buildComponent(1, -1);

            expect(componentDriven.events).to.deep.equal(stateDriven.events);
            expect(componentDriven.scales.map(v => Number(v.toFixed(5)))).to.deep.equal(
                stateDriven.scales.map(v => Number(v.toFixed(5)))
            );
        });

        it('clamps a non looping reverse animation at the start instead of freezing on the first frame', function () {
            const { clipTime, clipLoop, scales, events } = buildComponent(-1, 1, false);

            // it plays backwards from the end of the track and clamps at the start...
            expect(clipTime).to.be.closeTo(0, 1e-9);
            expect(clipLoop).to.equal(false);
            // ...and the poses actually changed along the way, with events firing
            expect(new Set(scales.map(v => v.toFixed(5))).size).to.be.greaterThan(1);
            expect(events).to.deep.equal(['late', 'early']);
        });

        it('reverses immediately when the component speed sign flips at runtime', function () {
            const root = new Entity('root', app);
            app.root.addChild(root);
            root.addComponent('anim', { activate: true });
            root.anim.assignAnimation('State', speedTrack(), undefined, 1, true);

            for (let i = 0; i < 5; i++) {
                app.systems.anim.onAnimationUpdate(0.1);
            }
            const clip = root.anim.baseLayer._controller.animEvaluator.clips[0];
            expect(clip.time).to.be.closeTo(0.5, 1e-9);
            expect(clip.isReverse).to.equal(false);

            root.anim.speed = -1;
            for (let i = 0; i < 3; i++) {
                app.systems.anim.onAnimationUpdate(0.1);
            }
            expect(clip.isReverse).to.equal(true);
            expect(clip.time).to.be.closeTo(0.2, 1e-9);
        });

        it('pauses playback when the component speed is zero', function () {
            const { clipSpeed, scales } = buildComponent(0, 1);
            expect(clipSpeed).to.equal(0);
            // every frame samples the start pose because the clips never advance
            expect(new Set(scales.map(v => v.toFixed(5))).size).to.equal(1);
            expect(scales[0]).to.be.closeTo(0, 1e-5);
        });
    });
});
