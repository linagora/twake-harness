import { PullPolicy, type ImagePullPolicy } from 'testcontainers';

// A test container about to start, which can be told to pull its image even where it has one
export interface PullableContainer<T> {
	start(): Promise<T>;
	withPullPolicy(policy: ImagePullPolicy): unknown;
}

// Starts a test container, and pulls its image again, once, when the start finds it gone. The
// runners' Docker can lose an image during a run, and testcontainers never pulls again an image it
// has seen once in the process: every later start of that image would fail with "No such image".
export async function startPulling<T>(container: PullableContainer<T>): Promise<T> {
	try {
		return await container.start();
	} catch (err: unknown) {
		if (!(err instanceof Error) || !err.message.toLowerCase().includes('no such image')) throw err;
		container.withPullPolicy(PullPolicy.alwaysPull());
		return await container.start();
	}
}
