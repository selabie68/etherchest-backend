/*
  args:
    client: A dsteem client to use to get blocks, etc. [REQUIRED]
    steem: A dsteem instance. [REQIURED]
    currentBlockNumber: The last block that has been processed by this client; should be
      loaded from some sort of storage file. Default is block 1.
    blockComputeSpeed: The amount of milliseconds to wait before processing
      another block (not used when streaming)
    prefix: The prefix to use for each transaction id, to identify the DApp which
      is using these transactions (interfering transaction with other Dappsids could cause
      errors)
    mode: Whether to stream blocks as `latest` or `irreversible`.
    unexpectedStopCallback: A function to call when steem-state stops unexpectedly
      due to an error.
*/
module.exports = function(client, dhive, currentBlockNumber=1, blockComputeSpeed=100, prefix='etherchest_', mode='latest', unexpectedStopCallback=function(){}) {
  var onCustomJsonOperation = {};  // Stores the function to be run for each operation id.
  var onOperation = {};

  var onNewBlock = function() {};
  var onStreamingStart = function() {};

  var isStreaming;

  var stream;

  var stopping = false;
  var stopCallback;


  // Returns the block number of the last block on the chain or the last irreversible block depending on mode.
  function getHeadOrIrreversibleBlockNumber(callback) {
    client.database.getDynamicGlobalProperties().then(function(result) {
      if(mode === 'latest') {
        callback(result.head_block_number);
      } else {
        callback(result.last_irreversible_block_num);
      }
    }).catch(function (err) {
      console.log("Error, steem-state is unexpectedly stopping:", err)
      unexpectedStopCallback(err)
    })
  }

  function isAtRealTime(callback) {
    getHeadOrIrreversibleBlockNumber(function(result) {
      if(currentBlockNumber >= result) {
        callback(true);
      } else {
        callback(false);
      }
    })
  }

  function beginBlockComputing() {
    function computeBlock() {

      var blockNum = currentBlockNumber;// Helper variable to prevent race condition
                                        // in getBlock()
      client.database.getBlock(blockNum)
        .then((result) => {
          processBlock(result, blockNum);
        })
        .catch((err) => {
          throw err;
        })

      currentBlockNumber++;
      if(!stopping) {
        isAtRealTime(function(result) {
          if(!result) {
            setTimeout(computeBlock, blockComputeSpeed);
          } else {
            beginBlockStreaming();
          }
        })
      } else {
        setTimeout(stopCallback,1000);
      }
    }

    computeBlock();
  }

  function beginBlockStreaming() {
    isStreaming = true;
    onStreamingStart();
    if(mode === 'latest') {
      stream = client.blockchain.getBlockStream({mode: dhive.BlockchainMode.Latest});
    } else {
      stream = client.blockchain.getBlockStream();
    }
    stream.on('data', function(block) {
      var blockNum = parseInt(block.block_id.slice(0,8), 16);
      if(blockNum >= currentBlockNumber) {
        processBlock(block, blockNum);
        currentBlockNumber = blockNum+1;
      }
    })
    stream.on('end', function() {
      console.error("Block stream ended unexpectedly. Restarting block computing.")
      beginBlockComputing();
    })
    stream.on('error', function(err) {
      throw err;
    })
  }

  function processBlock(block, num) {
    onNewBlock(num, block);
    var transactions = block.transactions;

    for(var i = 0; i < transactions.length; i++) {
      for(var j = 0; j < transactions[i].operations.length; j++) {

        var op = transactions[i].operations[j];
        if(op[0] === 'custom_json') {
          if(typeof onCustomJsonOperation[op[1].id] === 'function') {
            var ip = JSON.parse(op[1].json);
            var from = op[1].required_posting_auths[0];
            var active = false;
            ip.transaction_id = transactions[i].transaction_id
            ip.block_num = transactions[i].block_num
            if(!from){from = op[1].required_auths[0];active=true}
            onCustomJsonOperation[op[1].id](ip, from, active);
          }
        } else if(onOperation[op[0]] !== undefined) {
          op[1].transaction_id = transactions[i].transaction_id
          op[1].block_num = transactions[i].block_num
          onOperation[op[0]](op[1]);
        }
      }
    }
  }

  return {
    /*
      Determines a state update to be called when a new operation of the id
        operationId (with added prefix) is computed.
    */
    on: function(operationId, callback) {
      onCustomJsonOperation[prefix + operationId] = callback;
    },

    onOperation: function(type, callback) {
      onOperation[type] = callback;
    },

    onNoPrefix: function(operationId, callback) {
      onCustomJsonOperation[operationId] = callback;
    },

    /*
      Determines a state update to be called when a new block is computed.
    */
    onBlock: function(callback) {
      onNewBlock = callback;
    },

    start: function() {
      beginBlockComputing();
      isStreaming = false;
    },

    getCurrentBlockNumber: function() {
      return currentBlockNumber;
    },

    isStreaming: function() {
      return isStreaming;
    },

    onStreamingStart: function(callback) {
      onStreamingStart = callback;
    },

    stop: function(callback) {
      if(isStreaming){
        stopping = true;
        stream.pause();
        setTimeout(callback,1000);
      } else {
        stopping = true;
        stopCallback = callback;
      }
    }
  }
}