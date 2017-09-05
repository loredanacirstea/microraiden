function pageReady(json) {
  window.uraiden = new MicroRaiden(
    window.web3,
    json["contractAddr"],
    json["contractABI"],
    json["tokenAddr"],
    json["tokenABI"],
  );

  // you can set this variable in a new 'script' tag, for example
  if (!window.uRaidenParams && Cookies.get("RDN-Price")) {
    window.uRaidenParams = {
      receiver: Cookies.get("RDN-Receiver-Address"),
      amount: +(Cookies.get("RDN-Price")),
      token: json["tokenAddr"],
    };
  } else if (!window.uRaidenParams) {
    window.uRaidenParams = {
      receiver: json["receiver"],
      amount: json["amount"],
      token: json["tokenAddr"],
    };
  }

  uraiden.getTokenInfo((err, token) => {
    if (err) {
      return console.error('Error getting token info', err);
    }
    $('.tkn-name').text(token.name);
    $('.tkn-symbol').text(token.symbol);
  });

  $("#amount").text(uRaidenParams["amount"]);
  $("#token").text(uRaidenParams.token);

  let $select = $("#accounts");

  function mainSwitch(id) {
    $(".main_switch"+id).show();
    $(".main_switch:not("+id+")").hide();
    $(".container").show();
  }

  let autoSign = false;
  $select.change(($event) => {
    uraiden.loadStoredChannel($event.target.value, uRaidenParams.receiver);

    if (uraiden.isChannelValid() &&
        uraiden.channel.account === $event.target.value &&
        uraiden.channel.receiver === uRaidenParams.receiver) {

      mainSwitch("#channel_present");

      uraiden.getChannelInfo((err, info) => {
        if (err) {
          console.error(err);
          info = { state: "error", deposit: 0 }
        } else if (Cookies.get("RDN-Nonexisting-Channel")) {
          Cookies.remove("RDN-Nonexisting-Channel");
          window.alert("Server won't accept this channel.\n" +
            "Please, close+settle+forget, and open a new channel");
          $('#channel_present .channel_present_sign').attr("disabled", true);
          autoSign = false;
        }

        $(`#channel_present .on-state.on-state-${info.state}`).show();
        $(`#channel_present .on-state:not(.on-state-${info.state})`).hide();

        let remaining = 0;
        if (info.deposit > 0 && uraiden.channel && !isNaN(uraiden.channel.balance)) {
          remaining = info.deposit - uraiden.channel.balance;
        }
        $("#channel_present #channel_present_balance").text(remaining);
        $("#channel_present #channel_present_deposit").attr("value", info.deposit);
        $(".btn-bar").show()
        if (info.state === 'opened' && autoSign) {
          signRetry();
        }
      });
    } else {
      mainSwitch("#channel_missing");
    }
  });

  function refreshAccounts(_autoSign) {
    $(`#channel_present .on-state.on-state-opened`).show();
    $(`#channel_present .on-state:not(.on-state-opened)`).hide();
    if (_autoSign) {
      autoSign = true;
    }

    $select.empty();
    uraiden.getAccounts((err, accounts) => {
      if (err || !accounts || !accounts.length) {
        mainSwitch("#no_accounts");
        // retry after 1s
        setTimeout(refreshAccounts, 1000);
      } else {
        $.each(accounts, (k,v) => {
          const o = $("<option></option>").attr("value", v).text(v);
          $select.append(o);
          if (k === 0) {
            o.change()
          };
        });
      }
    });
  }

  refreshAccounts(true);

  function signRetry() {
    autoSign = false;
    uraiden.incrementBalanceAndSign(uRaidenParams.amount, (err, sign) => {
      if (err && err.message && err.message.includes('Insuficient funds')) {
        console.error(err);
        const current = +(err.message.match(/current ?= ?(\d+)/i)[1]);
        const required = +(err.message.match(/required ?= ?(\d+)/i)[1]) - current;
        $('#deposited').text(current);
        $('#required').text(required);
        $('#remaining').text(current - uraiden.channel.balance);
        return mainSwitch("#topup");
      } else if (err && err.message && err.message.includes('User denied message signature')) {
        console.error(err);
        $('.channel_present_sign').addClass('green-btn');
        return refreshAccounts();
      } else if (err) {
        console.error(err);
        window.alert(`An error occurred trying to sign the transfer: ${err.message}`);
        return refreshAccounts();
      }
      $('.channel_present_sign').removeClass('green-btn')
      console.log("SIGNED!", sign);
      Cookies.set("RDN-Sender-Address", uraiden.channel.account);
      Cookies.set("RDN-Open-Block", uraiden.channel.block);
      Cookies.set("RDN-Sender-Balance", uraiden.channel.balance);
      Cookies.set("RDN-Balance-Signature", sign);
      location.reload();
    });
  }

  $("#channel_missing_deposit").bind("input", ($event) => {
    if (+$event.target.value > 0) {
      $("#channel_missing_start").attr("disabled", false);
    } else {
      $("#channel_missing_start").attr("disabled", true);
    }
  });
  $("#channel_missing_start").attr("disabled", false);

  $("#channel_missing_start").click(() => {
    const deposit = +$("#channel_missing_deposit").val();
    const account = $("#accounts").val();
    mainSwitch("#channel_opening");
    uraiden.openChannel(account, uRaidenParams.receiver, deposit, (err, channel) => {
      if (err) {
        console.error(err);
        window.alert(`An error ocurred trying to open a channel: ${err.message}`);
        return refreshAccounts();
      }
      return signRetry();
    });
  });

  $(".channel_present_sign").click(signRetry);

  function closeChannel(closeSign) {
    uraiden.closeChannel(closeSign, (err, res) => {
      if (err) {
        window.alert(`An error occurred trying to close the channel: ${err.message}`);
        return refreshAccounts();
      }
      console.log("CLOSED", res);
      refreshAccounts();
    });
  }

  $(".channel_present_close").click(() => {
    if (!window.confirm("Are you sure you want to close this channel?")) {
      return;
    }
    mainSwitch("#channel_opening");
    // signBalance without balance, sign current balance only if needed
    uraiden.signBalance(null, (err, sign) => {
      if (err) {
        window.alert(`An error occurred trying to get balance signature: ${err.message}`);
        return refreshAccounts();
      }
      // call cooperative-close URL, and closeChannel with close_signature data
      $.ajax({
        url: `/api/1/channels/${uraiden.channel.account}/${uraiden.channel.block}`,
        method: 'DELETE',
        contentType: 'application/json',
        dataType: 'json',
        data: JSON.stringify({ 'balance': uraiden.channel.balance }),
        success: (result) => {
          let closeSign = null;
          if (result && typeof result === 'object' && result['close_signature']) {
            closeSign = result['close_signature'];
          } else {
            console.warn('Invalid cooperative-close response', result);
          }
          closeChannel(closeSign);
        },
        error: (request, msg, error) => {
          console.warn('Error calling cooperative-close', request, msg, error);
          closeChannel(null);
        }
      });
    });
  });

  $(".channel_present_settle").click(() => {
    if (!window.confirm("Are you sure you want to settle this channel?")) {
      return;
    }
    mainSwitch("#channel_opening");
    uraiden.settleChannel((err, res) => {
      if (err) {
        window.alert(`An error occurred trying to settle the channel: ${err.message}`);
        return refreshAccounts();
      }
      console.log("SETTLED", res);
      refreshAccounts();
    });
  });

  $(".channel_present_forget").click(() => {
    if (!window.confirm("Are you sure you want to forget this channel?" +
        ($('.on-state-settled').is(':visible') ? "" :
         "\nWarning: channel will be left in an unsettled state."))) {
      return;
    }
    uraiden.forgetStoredChannel();
    refreshAccounts();
  });

  $("#topup_deposit").bind("input", ($event) => {
    if (+$event.target.value > 0) {
      $("#topup_start").attr("disabled", false);
    } else {
      $("#topup_start").attr("disabled", true);
    }
  });

  $("#topup_start").click(() => {
    const deposit = +$("#topup_deposit").val();
    mainSwitch("#channel_opening");
    uraiden.topUpChannel(deposit, (err, block) => {
      if (err) {
        refreshAccounts();
        console.error(err);
        return window.alert(`An error ocurred trying to deposit to channel: ${err.message}`);
      }
      return signRetry();
    });
  });

};

$.getJSON("/js/parameters.json", (json) => {
  let cnt = 20;
  // wait up to 20*200ms for web3 and call ready()
  const pollingId = setInterval(() => {
    if (Cookies.get("RDN-Insufficient-Confirmations")) {
      Cookies.remove("RDN-Insufficient-Confirmations");
      clearInterval(pollingId);
      $("body").html('<h1>Waiting confirmations...</h1>');
      setTimeout(() => location.reload(), 5000);
    } else if (cnt < 0 || window.web3) {
      clearInterval(pollingId);
      pageReady(json);
    } else {
      --cnt;
    }
  }, 200);
});
