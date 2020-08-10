import React from 'react';
import './PlaceOrder.css';
import * as transactions from '@liskhq/lisk-transactions';
import axios from 'axios';
import BalanceDisplay from './BalanceDisplay';
import userContext from './context';
import Modal from './Modal';
import {
  getCleanOrderBook, estimateBestReturnsForSeller, estimatedBestReturnsForBuyer, EstimationStatus,
} from './Utils';
import InfoIcon from './InfoIcon';
import marketInfoDescriptor from './Market';

export default class PlaceOrder extends React.Component {
  static contextType = userContext;

  constructor(props, context) {
    super(props, context);
    this.state = {
      price: 0,
      amount: 0,
      marketMode: true,
      isSubmitting: false,
      errors: {},
      isActionInfoModalOpen: false,
    };
  }

  handleChange = (event) => {
    const { target } = event;
    const value = target.type === 'checkbox' ? target.checked : target.value;
    const { name } = target;
    const isNumber = value === '' || /^([\d]+\.?|[\d]*\.[\d]+)$/.test(value);
    if (isNumber) {
      this.setState({
        [name]: value,
      });
    }
  }

  openActionInfoModal = () => {
    this.setState({
      isActionInfoModalOpen: true,
    });
  }

  closeActionInfoModal = () => {
    this.setState({
      isActionInfoModalOpen: false,
    });
  }

  openEstimateInfoModal = () => {
    this.setState({
      isEstimateInfoModalOpen: true,
    });
  }

  closeEstimateInfoModal = () => {
    this.setState({
      isEstimateInfoModalOpen: false,
    });
  }

  getOrderType() {
    return this.state.marketMode ? 'market' : 'limit';
  }

  getEstimatedReturns() {
    const orderBook = getCleanOrderBook(this.context.orderBookData);
    const amount = parseFloat(this.state.amount) || 0;

    const { asks } = orderBook;
    const { bids } = orderBook;
    let estimatedReturns = { };
    let assetExchanged = '';
    let assetExchangedAgainst = '';
    const { price } = this.state;
    const isMarketOrder = this.getOrderType() === 'market';
    if (this.props.side === 'ask') {
      estimatedReturns = estimateBestReturnsForSeller(amount, price, bids, isMarketOrder);
      assetExchanged = this.context.activeAssets[1].toUpperCase();
      assetExchangedAgainst = this.context.activeAssets[0].toUpperCase();
    } else {
      estimatedReturns = estimatedBestReturnsForBuyer(amount, price, asks, isMarketOrder);
      assetExchanged = this.context.activeAssets[0].toUpperCase();
      assetExchangedAgainst = this.context.activeAssets[1].toUpperCase();
    }
    return { ...estimatedReturns, assetExchanged, assetExchangedAgainst };
  }

  getEstimatedReturnsBreakDown(estimate) {
    let verboseEstimation = `${estimate.estimatedReturns.toFixed(4)} ${estimate.assetExchanged}`;
    const statuses = [];
    if (estimate.status === EstimationStatus.PARTIAL_MATCH || estimate.amountYetToBeSold > 0) {
      verboseEstimation += ` + ${estimate.amountYetToBeSold.toFixed(4)} ${estimate.assetExchangedAgainst}`;
      if (this.getOrderType() === 'market') {
        verboseEstimation += ' (refund)';
        statuses.push('refund');
      } else {
        verboseEstimation += ' (pending)';
        statuses.push('pending');
      }
    }
    return (
      <span>
        <span style={{ display: 'inline-block' }}>{verboseEstimation}</span>
        &nbsp;&nbsp;
        <InfoIcon alt="info" width="18px" onClick={this.openEstimateInfoModal} />
      </span>
    );
  }

  handleSubmit = (event) => {
    event.preventDefault();
    this.clearErrors();
    if (this.validateOrder()) {
      const confirmed = window.confirm(`Are you sure you want to place this ${this.getOrderType()} order?`);
      if (confirmed) {
        this.placeOrder();
        this.clearValues();
      }
    }
  }

  switchMode = () => {
    this.clearErrors();
    this.setState((prevState) => ({ marketMode: !prevState.marketMode }));
  }

  validateOrder() {
    const baseFee = this.getBaseFee();
    let success = true;
    const { marketOptions } = this.context.configuration.markets[this.context.activeMarket];
    const { priceDecimalPrecision } = marketOptions;
    const sourceAsset = this.props.side === 'bid' ? this.context.activeAssets[1] : this.context.activeAssets[0];
    const sourceAssetBaseFee = baseFee[sourceAsset];
    const actualAssetBalance = this.getAssetBalance() - sourceAssetBaseFee;
    const { unitValue } = this.context.configuration.assets[sourceAsset];
    const minOrderAmount = marketOptions.chains[sourceAsset].minOrderAmount / unitValue;
    const price = parseFloat(this.state.price);
    const amount = parseFloat(this.state.amount);
    const errors = {
      price: null,
      amount: null,
    };
    if (Number.isNaN(this.state.amount) || this.state.amount === '') {
      errors.amount = 'The order amount must be a number.';
      success = false;
    } else if (amount > actualAssetBalance) {
      errors.amount = 'Insufficient balance!';
      success = false;
    } else if (!this.state.marketMode) {
      if (Number.isNaN(this.state.price) || this.state.price === '') {
        errors.price = 'The order price must be a number.';
        success = false;
      } else if (price === 0) {
        errors.price = 'The order price cannot be 0.';
        success = false;
      } else if (priceDecimalPrecision != null && (price.toString().split('.')[1] || '').length > priceDecimalPrecision) {
        errors.price = `The order price for this DEX market cannot have more than ${priceDecimalPrecision} decimal place${priceDecimalPrecision === 1 ? '' : 's'}.`;
        success = false;
      }
    } else if (amount < minOrderAmount) {
      errors.amount = `The specified amount was less than the minimum order amount allowed by this DEX market which is ${
        minOrderAmount
      } ${sourceAsset.toUpperCase()}.`;
      success = false;
    }

    if (!success) {
      this.setState({
        errors,
      });
    }
    return success;
  }

  clearErrors() {
    this.setState({
      errors: {},
    });
  }

  // todo : need to check at what other places this can be used
  clearValues() {
    this.setState({
      price: 0,
      amount: 0,
    });
  }


  generateOrder(tx, type, sourceChain, targetChain, side, price) {
    const order = {
      id: tx.id,
      type,
      side,
      senderId: tx.senderId,
      recipientId: tx.recipientId,
      sourceChain,
      targetChain,
    };
    if (side === 'bid') {
      order.value = tx.amount;
      order.valueRemaining = order.value;
    } else {
      order.size = tx.amount;
      order.sizeRemaining = order.size;
    }
    if (price != null) {
      order.price = price;
    }
    return order;
  }

  handleTransactionSubmit(tx, type, sourceChain, targetChain, side, price) {
    const order = this.generateOrder(tx, type, sourceChain, targetChain, side, price);
    this.props.orderSubmit(order);
  }

  placeOrder() {
    if (this.state.marketMode) {
      let dexAddress;
      let destAddress;
      let passphrase;
      let sourceChain;
      let targetChain;
      let broadcastURL;
      if (this.props.side === 'bid') {
        dexAddress = this.context.configuration.markets[this.context.activeMarket].marketOptions.chains[this.context.activeAssets[1]].walletAddress;
        destAddress = this.context.keys[this.context.activeAssets[0]].address;
        passphrase = this.context.keys[this.context.activeAssets[1]].passphrase;
        [targetChain, sourceChain] = this.context.activeAssets;
        broadcastURL = this.context.configuration.assets[this.context.activeAssets[1]].apiUrl;
      } else if (this.props.side === 'ask') {
        dexAddress = this.context.configuration.markets[this.context.activeMarket].marketOptions.chains[this.context.activeAssets[0]].walletAddress;
        destAddress = this.context.keys[this.context.activeAssets[1]].address;
        passphrase = this.context.keys[this.context.activeAssets[0]].passphrase;
        [sourceChain, targetChain] = this.context.activeAssets;
        broadcastURL = this.context.configuration.assets[this.context.activeAssets[0]].apiUrl;
      }

      if (dexAddress && destAddress && passphrase && targetChain && broadcastURL) {
        if (this.state.amount > 0) {
          const { side } = this.props;
          const tx = transactions.transfer({
            amount: transactions.utils.convertLSKToBeddows(this.state.amount.toString()).toString(),
            recipientId: dexAddress,
            data: `${targetChain},market,${destAddress}`,
            passphrase,
          });
          (async () => {
            await this.setState({ isSubmitting: true });
            try {
              await axios.post(`${broadcastURL}/transactions`, tx);
            } catch (err) {
              const error = new Error(`Failed to post market order because of error: ${err.message}`);
              error.response = err.response;
              error.order = this.generateOrder(tx, 'market', sourceChain, targetChain, side);
              if (this.props.orderSubmitError) {
                this.props.orderSubmitError(error);
              }
              await this.setState({ isSubmitting: false });
              return;
            }
            await this.setState({ isSubmitting: false });
            this.handleTransactionSubmit(tx, 'market', sourceChain, targetChain, side);
          })();
        }
      }
    } else {
      let dexAddress;
      let destAddress;
      let passphrase;
      let sourceChain;
      let targetChain;
      let broadcastURL;
      if (this.props.side === 'bid') {
        dexAddress = this.context.configuration.markets[this.context.activeMarket].marketOptions.chains[this.context.activeAssets[1]].walletAddress;
        destAddress = this.context.keys[this.context.activeAssets[0]].address;
        passphrase = this.context.keys[this.context.activeAssets[1]].passphrase;
        [targetChain, sourceChain] = this.context.activeAssets;
        broadcastURL = this.context.configuration.assets[this.context.activeAssets[1]].apiUrl;
      } else if (this.props.side === 'ask') {
        dexAddress = this.context.configuration.markets[this.context.activeMarket].marketOptions.chains[this.context.activeAssets[0]].walletAddress;
        destAddress = this.context.keys[this.context.activeAssets[1]].address;
        passphrase = this.context.keys[this.context.activeAssets[0]].passphrase;
        [sourceChain, targetChain] = this.context.activeAssets;
        broadcastURL = this.context.configuration.assets[this.context.activeAssets[0]].apiUrl;
      }

      if (dexAddress && destAddress && passphrase && targetChain && broadcastURL) {
        if (this.state.amount > 0) {
          const { price } = this.state;
          const { side } = this.props;
          const tx = transactions.transfer({
            amount: transactions.utils.convertLSKToBeddows(this.state.amount.toString()).toString(),
            recipientId: dexAddress,
            data: `${targetChain},limit,${price},${destAddress}`,
            passphrase,
          });
          (async () => {
            await this.setState({ isSubmitting: true });
            try {
              await axios.post(`${broadcastURL}/transactions`, tx);
            } catch (err) {
              const error = new Error(`Failed to post limit order because of error: ${err.message}`);
              error.response = err.response;
              error.order = this.generateOrder(tx, 'limit', sourceChain, targetChain, side, parseFloat(price));
              if (this.props.orderSubmitError) {
                this.props.orderSubmitError(error);
              }
              await this.setState({ isSubmitting: false });
              return;
            }
            await this.setState({ isSubmitting: false });
            this.handleTransactionSubmit(tx, 'limit', sourceChain, targetChain, side, parseFloat(price));
          })();
        }
      }
    }
  }

  getAssetBalance() {
    const whole = 10 ** 8;
    return Math.round((this.props.assetBalance * 100) / whole) / 100;
  }

  getBaseFee() {
    const dexConfig = this.props.configuration.markets[this.props.activeMarket].marketOptions;
    const chains = Object.keys(dexConfig.chains);
    const firstChain = dexConfig.chains[chains[0]];
    const secondChain = dexConfig.chains[chains[1]];
    const baseFeeKey = 'exchangeFeeBase';
    const keyDescriptor = marketInfoDescriptor[baseFeeKey];
    const firstChainBaseFee = firstChain[baseFeeKey] / keyDescriptor.div;
    const secondChainBaseFee = secondChain[baseFeeKey] / keyDescriptor.div;
    return { [chains[0]]: firstChainBaseFee, [chains[1]]: secondChainBaseFee };
  }

  render() {
    let totalKeys = 0;
    const quoteAssetInfo = this.context.keys[this.context.activeAssets[0]];
    const baseAssetInfo = this.context.keys[this.context.activeAssets[1]];
    if (quoteAssetInfo) {
      totalKeys++;
    }
    if (baseAssetInfo) {
      totalKeys++;
    }

    const walletAddress1 = quoteAssetInfo ? quoteAssetInfo.address : 'Not Available';
    const walletAddress2 = baseAssetInfo ? baseAssetInfo.address : 'Not Available';

    const canTrade = totalKeys === 2;
    const estimate = this.getEstimatedReturns();
    let actionTitle;
    let actionDescription;
    if (this.props.side === 'bid') {
      actionTitle = `BUY ${this.context.activeAssets[0].toUpperCase()}`;
      actionDescription = `The BUY panel lets you convert your ${this.context.activeAssets[1].toUpperCase()} into ${this.context.activeAssets[0].toUpperCase()}.`;
    } else {
      actionTitle = `SELL ${this.context.activeAssets[0].toUpperCase()}`;
      actionDescription = `The SELL panel lets you convert your ${this.context.activeAssets[0].toUpperCase()} into ${this.context.activeAssets[1].toUpperCase()}.`;
    }

    return (
      <div style={{ padding: '5px' }}>
        <Modal modalOpened={this.state.isActionInfoModalOpen} closeModal={this.closeActionInfoModal}>
          {actionDescription}
        </Modal>
        <Modal modalOpened={this.state.isEstimateInfoModalOpen} closeModal={this.closeEstimateInfoModal}>
          The trade estimator gives you a breakdown of the number of tokens which you can expect to receive based on the values that you provide. It also makes projections about the expected status of your order.
          <ul>
            <li>A (pending) status means that some of the order cannot be filled immediately and will stay pending inside the order book until it is matched with future counteroffers.</li>
            <li>A (refund) status means that a portion of the order cannot be filled immediately and some tokens will be refunded back to your wallet - It is recommended that you reduce the size of your order to avoid this situation.</li>
          </ul>
        </Modal>
        <span className="action-name">{actionTitle}</span>
        &nbsp;&nbsp;
        <span style={{ display: 'inline-block', marginTop: '2px', verticalAlign: 'top' }}>
          <InfoIcon onClick={this.openActionInfoModal} alt="info" width="18px" />
        </span>
        <div className="market-limit-tabs" style={{ marginBottom: '10px' }}>
          <button type="button" className="tab-button" disabled={this.state.marketMode} onClick={this.switchMode}>Market</button>
          <button type="button" className="tab-button" disabled={!this.state.marketMode} onClick={this.switchMode}>Limit</button>
        </div>
        {this.props.side === 'bid' && this.context.keys[this.context.activeAssets[1]]
          && <BalanceDisplay asset={this.context.activeAssets[1]} balance={this.getAssetBalance()} walletAddress={walletAddress2} />}
        {this.props.side === 'ask' && this.context.keys[this.context.activeAssets[0]]
          && <BalanceDisplay asset={this.context.activeAssets[0]} balance={this.getAssetBalance()} walletAddress={walletAddress1} />}
        {canTrade
          && (
          <form onSubmit={this.handleSubmit}>
            {!this.state.marketMode
              && (
              <>
                Price:
                {' '}
                <br />
                {this.state.errors.price && <div className="error-message">{this.state.errors.price}</div>}
                <div className="price-container">
                  <input name="price" className="order-val-input" type="text" title="Decimal number" value={this.state.price} onChange={this.handleChange} />
                  <div className="input-chain-symbol">{(this.context.activeAssets[1] || '').toUpperCase()}</div>
                </div>
              </>
              )}
            Amount:
            {' '}
            <br />
            {this.state.errors.amount && <div className="error-message">{this.state.errors.amount}</div>}
            <div className="amount-container">
              <input name="amount" className="order-val-input" type="text" title="Decimal number" value={this.state.amount} onChange={this.handleChange} />
              <div className="input-chain-symbol">{(this.props.side === 'ask' ? this.context.activeAssets[0] : this.context.activeAssets[1] || '').toUpperCase()}</div>
            </div>
            {
               (
                 <div style={{ color: 'grey', fontSize: '15px', marginBottom: '10px' }}>
                   ≈
                   {this.getEstimatedReturnsBreakDown(estimate)}
                 </div>
               )
            }
            {this.props.side === 'bid' && <input className="place-buy-order-button" type="submit" value={this.state.isSubmitting ? '' : 'Submit'} disabled={this.state.isSubmitting} />}
            {this.props.side === 'ask' && <input className="place-sell-order-button" type="submit" value={this.state.isSubmitting ? '' : 'Submit'} disabled={this.state.isSubmitting} />}
            {this.state.isSubmitting && (
            <div
              className="lds-dual-ring"
              style={{
                display: 'inline-block', position: 'absolute', left: '48px', marginTop: '2px', marginLeft: '5px',
              }}
            />
            )}
          </form>
          )}
        {
          !canTrade
          && (
          <p style={{ color: 'grey' }}>
            Please sign in with your
            {' '}
            {this.context.activeAssets[0].toUpperCase()}
            {' '}
            <b>and</b>
            {' '}
            {this.context.activeAssets[1].toUpperCase()}
            {' '}
            passphrase to trade.
          </p>
          )
        }
      </div>
    );
  }
}
