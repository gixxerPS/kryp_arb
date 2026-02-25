import { EventEmitter } from 'events';

const bus = new EventEmitter();
bus.setMaxListeners(50);

export = bus;
