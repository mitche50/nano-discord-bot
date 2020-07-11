const fetch = require('node-fetch');

module.exports.coinGecko = async function() {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/nano');
    if (res.status !== 200) {
        throw new Error('Coingecko returned non-ok status code ' + res.status);
    }
    const json = await res.json();
    return {
        btc: (+json.market_data.current_price.btc).toFixed(8),
        usd: (+json.market_data.current_price.usd).toFixed(2),
        btcusd: Math.round(json.market_data.current_price.usd / json.market_data.current_price.btc).toLocaleString(), // it works :P
        volume: Math.round(json.market_data.total_volume.usd).toLocaleString(),
        market_cap: Math.round(json.market_data.market_cap.usd).toLocaleString(),
        cap_rank: Math.round(json.market_data.market_cap_rank).toLocaleString(),
        percent_change_1h: json.market_data.price_change_percentage_1h_in_currency.usd
    };
};

module.exports.exchanges = {};

module.exports.exchanges.Binance = async function() {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=NANOBTC');
    if (res.status !== 200) {
        throw new Error('Binance returned status code ' + res.status + '\n' + await res.text());
    }
    const json = await res.json();
    return (+json.price).toFixed(8);
};

module.exports.exchanges.KuCoin = async function() {
    const res = await fetch('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=NANO-BTC');
    if (res.status !== 200) {
        throw new Error('Kucoin returned status code ' + res.status + '\n' + await res.text());
    }
    const json = await res.json();
    if (json.code != 200000) { // Should be non-strict comparison (currently a string)
        throw new Error('Kucoin returned non-successful body: ' + JSON.stringify(json));
    }
    return (+json.data.price).toFixed(8);
};

module.exports.exchanges.Kraken = async function() {
    const pair = 'NANOXBT';
    const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
    if (res.status !== 200) {
        throw new Error('Kraken returned status code ' + res.status + '\n' + await res.text());
    }
    const json = await res.json();
    if (!json.result || !json.result[pair]) {
        throw new Error('Kraken returned non-successful body: ' + JSON.stringify(json));
    }
    return (+json.result[pair].c[0]).toFixed(8);
};
