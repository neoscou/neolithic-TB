/*
	Handles everything related to the connection to the server
*/

const user_config = require('./config.json');
const spawn = require('child_process').spawn;

class Ping{
	constructor(mod) {
		this._faked = { stage: {}, end: {} };
		this._ping_array = [];
		this._old_method_init = false;
		this.ping = 0;
		this.jitter = 0;
		this._skill_cache = null;
		this.mod = mod;

		this.setup();
	}

	setup = () => {
		const { mod } = this;
		const { command } = mod.require;

		mod.hook('S_ACTION_STAGE', 9, {order: 500, filter: {fake: null, silenced: null}}, this.s_action_stage);
		mod.hook('S_ACTION_END', 5, {order: 500, filter: {fake: null, silenced: null}}, this.s_action_end);

		command.add('ping', (x)=> {
			if(x === "x") {
				for(const ping of this._ping_array) {
					command.message("Fuck you taka: " + ping);
				}
			}
			const max = Math.max.apply(null, this._ping_array);
			const min = Math.min.apply(null, this._ping_array);
			
			let avg = 0;
			for(const x of this._ping_array) avg += x;
			avg = Math.floor(avg / this._ping_array.length);

			command.message(`Ping: min=${this.ping} avg=${avg} max=${max} variance=${max-min} jitter=${this.jitter}`);
		});

		if(user_config['fakePing'] !== false) {
			mod.hook('C_REQUEST_GAMESTAT_PING', 'raw', { order: 75 }, ()=> {
				mod.send('S_RESPONSE_GAMESTAT_PONG', 1, {});
				return false;
			});
		}

		if(user_config['usingVPN']) this.setup_old_ping_detection();
		else this.setup_listener();
	}

	setup_old_ping_detection = (force_start=false) => {
		if(this._old_method_init) return;
		this._old_method_init = true;

		const { mod } = this;
		let my_info = {
			"timer": null,
			"started": 0
		};

		const start_timer = () => my_info['timer'] = setTimeout(ping_server, 6000);
		const clear_timeout = () => clearTimeout(my_info['timer']);

		const ping_server = () => {
			clear_timeout();
			mod.toServer('C_REQUEST_GAMESTAT_PING', 1, {});
		};


		mod.hook('S_SPAWN_ME', 'raw', ()=> {
			clear_timeout();
			start_timer();
		});

		// clear timeout
		mod.hook('S_LOAD_TOPO', 'raw', clear_timeout);
		mod.hook('S_RETURN_TO_LOBBY', 'raw', clear_timeout);

		// fake ping response from server
		mod.hook('C_REQUEST_GAMESTAT_PING', 'raw', {order: 100, filter: {fake: null}}, (code, data, incoming, fake)=> {
			if(!fake) {
				setTimeout(()=> {
					mod.send('S_RESPONSE_GAMESTAT_PONG', 1, {});
				}, this.ping);
				return false;
			}else {
				my_info['started'] = Date.now();
			}
			
		});

		// got ping response from server
		mod.hook('S_RESPONSE_GAMESTAT_PONG', 'raw', {order: 100, filter: {silenced: null}}, (code, data, incoming, fake)=> {
			this.add_ping_result(Date.now() - my_info['started']);

			clear_timeout();
			// if this packet wasn't silenced before order 100, we want to start our timer
			if(!data.$silenced) start_timer();
			return false;
		});

		if(force_start) {
			if(!user_config['usingVPN']) this.destructor();
			ping_server();
		}
	}

	setup_listener = () => {
		const { mod } = this;

		const arr = [process.pid.toString(), user_config['pingRenewTimer'].toString(), mod.dispatch.connection.serverConnection.remoteAddress];
		// console.log(arr.join(" "));
		this.ping_checker = spawn(__dirname+'\\ConnectionStats.exe', arr);

		this.ping_checker.stdout.on('data', this.listener_response.bind(this));
	}

	listener_response = (data) => {
		if(data == null) return;
		// Data format: current_ping, min_ping, scuffed_jitter_algorithm
		data = data.toString();

		const arr = data.split(',');
		const current_ping = arr[0];
		const min_ping = arr[1];

		// Check if it's an invalid data entry
		if(min_ping <= 0 || current_ping >= 50000) return;

		this.add_ping_result(Number(current_ping));
	}

	add_ping_result = (ping) => {
		// Add data to the array
		this._ping_array.push(Number(ping));

		// Reduce the array if it's over the max size
		if(this._ping_array.length >= user_config['maxPingCacheSize']) this._ping_array.shift();

		// Update data
		this.ping = Math.min.apply(null, this._ping_array);
	}

	calculate_jitter = (key, skill_id) => {
		if(this.ping === 0) {
			this.setup_old_ping_detection(true);
		}

		const jitter = Date.now() - this._faked[key][skill_id] - this.ping;

		if(0 <= jitter && jitter <= user_config['maxAcceptedJitter']) return jitter;
		return this.jitter;
	}


	fix_event = (e, fake) => {
		const { library: { player } } = this.mod.require;

		if(player.job !== 9) return;

		if(fake && Math.floor(e.skill.id / 10000) === 21) {
			this._skill_cache = e.skill.id;
			return;
		}

		if((e.skill.id - (player.templateId * 100)) !== 8 || !this._skill_cache) return;
		e.skill.id = this._skill_cache;
	}

	s_action_stage = (e, fake) => {
		const { library: { player } } = this.mod.require;
		if(!player.isMe(e.gameId) || e.stage) return;

		this.fix_event(e, fake);
		if(fake) this._faked['stage'][e.skill.id] = Date.now();
		else this.jitter = this.calculate_jitter("stage", e.skill.id);
	}

	s_action_end = (e, fake) => {
		const { library: { player } } = this.mod.require;
		if(!player.isMe(e.gameId)) return;

		this.fix_event(e, fake);
		if(fake) this._faked['end'][e.skill.id] = Date.now();
		else this.jitter = this.calculate_jitter("end", e.skill.id);
	}
	
	destructor = () => {
		try {
			this.ping_checker.kill();
		}catch(e) {}
	}
}


module.exports.NetworkMod = Ping;
module.exports.RequireInterface = (globalMod, clientMod, networkMod) => networkMod;