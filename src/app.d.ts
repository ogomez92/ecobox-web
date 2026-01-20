/// <reference types="@sveltejs/kit" />

declare global {
	namespace App {
		interface Error {
			message: string;
			code?: string;
		}
		interface Locals {
			db: import('$server/db').Database;
		}
		interface PageData {}
		interface PageState {}
		interface Platform {}
	}
}

export {};
