const {errorUtils} = require('@parcel/utils');
const {serialize, deserialize} = require('@parcel/utils/serializer');

class Child {
  constructor() {
    if (!process.send) {
      throw new Error('Only create Child instances in a worker!');
    }

    this.module = undefined;
    this.childId = undefined;

    this.callQueue = [];
    this.responseQueue = new Map();
    this.responseId = 0;
    this.maxConcurrentCalls = 10;
  }

  messageListener(data) {
    if (data === 'die') {
      return this.end();
    }

    data = deserialize(data);

    let type = data.type;
    if (type === 'response') {
      return this.handleResponse(data);
    } else if (type === 'request') {
      return this.handleRequest(data);
    }
  }

  async send(data) {
    data = serialize(data);
    process.send(data, err => {
      if (err && err instanceof Error) {
        if (err.code === 'ERR_IPC_CHANNEL_CLOSED') {
          // IPC connection closed
          // no need to keep the worker running if it can't send or receive data
          return this.end();
        }
      }
    });
  }

  childInit(module, childId) {
    this.module = require(module);
    this.childId = childId;
  }

  async handleRequest(data) {
    let idx = data.idx;
    let child = data.child;
    let method = data.method;
    let args = data.args;

    let result = {idx, child, type: 'response'};
    try {
      result.contentType = 'data';
      if (method === 'childInit') {
        result.content = this.childInit(...args, child);
      } else {
        result.content = await this.module[method](...args);
      }
    } catch (e) {
      result.contentType = 'error';
      result.content = errorUtils.errorToJson(e);
    }

    this.send(result);
  }

  async handleResponse(data) {
    let idx = data.idx;
    let contentType = data.contentType;
    let content = data.content;
    let call = this.responseQueue.get(idx);

    if (contentType === 'error') {
      call.reject(errorUtils.jsonToError(content));
    } else {
      call.resolve(content);
    }

    this.responseQueue.delete(idx);

    // Process the next call
    this.processQueue();
  }

  // Keep in mind to make sure responses to these calls are JSON.Stringify safe
  async addCall(request, awaitResponse = true) {
    let call = request;
    call.type = 'request';
    call.child = this.childId;
    call.awaitResponse = awaitResponse;

    let promise;
    if (awaitResponse) {
      promise = new Promise((resolve, reject) => {
        call.resolve = resolve;
        call.reject = reject;
      });
    }

    this.callQueue.push(call);
    this.processQueue();

    return promise;
  }

  async sendRequest(call) {
    let idx;
    if (call.awaitResponse) {
      idx = this.responseId++;
      this.responseQueue.set(idx, call);
    }
    this.send({
      idx: idx,
      child: call.child,
      type: call.type,
      location: call.location,
      method: call.method,
      args: call.args,
      awaitResponse: call.awaitResponse
    });
  }

  async processQueue() {
    if (!this.callQueue.length) {
      return;
    }

    if (this.responseQueue.size < this.maxConcurrentCalls) {
      this.sendRequest(this.callQueue.shift());
    }
  }

  end() {
    process.exit();
  }
}

let child = new Child();
process.on('message', child.messageListener.bind(child));

module.exports = child;
