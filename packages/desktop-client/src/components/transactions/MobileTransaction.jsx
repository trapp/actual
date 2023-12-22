import React, {
  PureComponent,
  Component,
  forwardRef,
  useEffect,
  useState,
  useRef,
} from 'react';
import { useSelector } from 'react-redux';
import { useParams } from 'react-router-dom';

import { useFocusRing } from '@react-aria/focus';
import { useListBox, useListBoxSection, useOption } from '@react-aria/listbox';
import { mergeProps } from '@react-aria/utils';
import { Item, Section } from '@react-stately/collections';
import { useListState } from '@react-stately/list';
import {
  format as formatDate,
  parse as parseDate,
  parseISO,
  isValid as isValidDate,
} from 'date-fns';
import { css } from 'glamor';
import memoizeOne from 'memoize-one';

import q, { runQuery } from 'loot-core/src/client/query-helpers';
import { send } from 'loot-core/src/platform/client/fetch';
import * as monthUtils from 'loot-core/src/shared/months';
import { getScheduledAmount } from 'loot-core/src/shared/schedules';
import {
  isPreviewId,
  ungroupTransactions,
  updateTransaction,
  realizeTempTransactions,
} from 'loot-core/src/shared/transactions';
import {
  titleFirst,
  integerToCurrency,
  integerToAmount,
  amountToInteger,
  getChangedValues,
  diffItems,
  groupById,
} from 'loot-core/src/shared/util';

import { useActions } from '../../hooks/useActions';
import useCategories from '../../hooks/useCategories';
import useNavigate from '../../hooks/useNavigate';
import { useSetThemeColor } from '../../hooks/useSetThemeColor';
import SvgAdd from '../../icons/v1/Add';
import SvgTrash from '../../icons/v1/Trash';
import ArrowsSynchronize from '../../icons/v2/ArrowsSynchronize';
import CheckCircle1 from '../../icons/v2/CheckCircle1';
import Lock from '../../icons/v2/LockClosed';
import SvgPencilWriteAlternate from '../../icons/v2/PencilWriteAlternate';
import { styles, theme } from '../../style';
import Button from '../common/Button';
import Text from '../common/Text';
import TextOneLine from '../common/TextOneLine';
import View from '../common/View';
import { FocusableAmountInput } from '../mobile/MobileAmountInput';
import {
  FieldLabel,
  TapField,
  InputField,
  BooleanField,
} from '../mobile/MobileForms';
import MobileBackButton from '../MobileBackButton';
import { Page } from '../Page';

const zIndices = { SECTION_HEADING: 10 };

const getPayeesById = memoizeOne(payees => groupById(payees));
const getAccountsById = memoizeOne(accounts => groupById(accounts));

function getDescriptionPretty(transaction, payee, transferAcct) {
  const { amount } = transaction;

  if (transferAcct) {
    return `Transfer ${amount > 0 ? 'from' : 'to'} ${transferAcct.name}`;
  } else if (payee) {
    return payee.name;
  }

  return '';
}

function serializeTransaction(transaction, dateFormat) {
  const { date, amount } = transaction;
  return {
    ...transaction,
    date: formatDate(parseISO(date), dateFormat),
    amount: integerToAmount(amount || 0),
  };
}

function deserializeTransaction(transaction, originalTransaction, dateFormat) {
  const { amount, date: originalDate, ...realTransaction } = transaction;

  const dayMonth = monthUtils.getDayMonthRegex(dateFormat);
  let date = originalDate;
  if (dayMonth.test(date)) {
    const test = parseDate(
      date,
      monthUtils.getDayMonthFormat(dateFormat),
      new Date(),
    );
    if (isValidDate(test)) {
      date = monthUtils.dayFromDate(test);
    } else {
      date = null;
    }
  } else {
    const test = parseDate(date, dateFormat, new Date());
    // This is a quick sanity check to make sure something invalid
    // like "year 201" was entered
    if (test.getFullYear() > 2000 && isValidDate(test)) {
      date = monthUtils.dayFromDate(test);
    } else {
      date = null;
    }
  }

  if (date == null) {
    date =
      (originalTransaction && originalTransaction.date) ||
      monthUtils.currentDay();
  }

  return { ...realTransaction, date, amount: amountToInteger(amount || 0) };
}

function lookupName(items, id) {
  if (!id) {
    return null;
  }
  return items.find(item => item.id === id)?.name;
}

function Status({ status }) {
  let color;

  switch (status) {
    case 'missed':
      color = theme.errorText;
      break;
    case 'due':
      color = theme.warningText;
      break;
    case 'upcoming':
      color = theme.tableHeaderText;
      break;
    default:
  }

  return (
    <Text
      style={{
        fontSize: 11,
        color,
        fontStyle: 'italic',
        textAlign: 'left',
      }}
    >
      {titleFirst(status)}
    </Text>
  );
}

class TransactionEditInner extends PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      transactions: props.transactions,
      editingChild: null,
    };
  }

  serializeTransactions = memoizeOne(transactions => {
    return transactions.map(t =>
      serializeTransaction(t, this.props.dateFormat),
    );
  });

  componentDidMount() {
    if (this.props.adding) {
      this.amount.focus();
    }
  }

  componentWillUnmount() {
    document
      .querySelector('meta[name="theme-color"]')
      .setAttribute('content', '#ffffff');
  }

  openChildEdit = child => {
    this.setState({ editingChild: child.id });
  };

  onAdd = () => {
    this.onSave();
  };

  onSave = async () => {
    const onConfirmSave = async () => {
      let { transactions } = this.state;
      const [transaction, ..._childTransactions] = transactions;
      const { account: accountId } = transaction;
      const account = getAccountsById(this.props.accounts)[accountId];

      if (transactions.find(t => t.account == null)) {
        // Ignore transactions if any of them don't have an account
        // TODO: Should we display validation error?
        return;
      }

      // Since we don't own the state, we have to handle the case where
      // the user saves while editing an input. We won't have the
      // updated value so we "apply" a queued change. Maybe there's a
      // better way to do this (lift the state?)
      if (this._queuedChange) {
        const [transaction, name, value] = this._queuedChange;
        transactions = await this.onEdit(transaction, name, value);
      }

      if (this.props.adding) {
        transactions = realizeTempTransactions(transactions);
      }

      this.props.onSave(transactions);
      this.props.navigate(`/accounts/${account.id}`, { replace: true });
    };

    const { transactions } = this.state;
    const [transaction] = transactions;

    if (transaction.reconciled) {
      // On mobile any save gives the warning.
      // On the web only certain changes trigger a warning.
      // Should we bring that here as well? Or does the nature of the editing form
      // make this more appropriate?
      this.props.pushModal('confirm-transaction-edit', {
        onConfirm: onConfirmSave,
        confirmReason: 'editReconciled',
      });
    } else {
      onConfirmSave();
    }
  };

  onSaveChild = childTransaction => {
    this.setState({ editingChild: null });
  };

  onEdit = async (transaction, name, value) => {
    const { transactions } = this.state;

    let newTransaction = { ...transaction, [name]: value };
    if (this.props.onEdit) {
      newTransaction = await this.props.onEdit(newTransaction);
    }

    const { data: newTransactions } = updateTransaction(
      transactions,
      deserializeTransaction(newTransaction, null, this.props.dateFormat),
    );

    this._queuedChange = null;
    this.setState({ transactions: newTransactions });
    return newTransactions;
  };

  onQueueChange = (transaction, name, value) => {
    // This is an ugly hack to solve the problem that input's blur
    // events are not fired when unmounting. If the user has focused
    // an input and swipes back, it should still save, but because the
    // blur event is not fired we need to manually track the latest
    // change and apply it ourselves when unmounting
    this._queuedChange = [transaction, name, value];
  };

  onClick = (transactionId, name) => {
    const { dateFormat } = this.props;

    this.props.pushModal('edit-field', {
      name,
      onSubmit: (name, value) => {
        const { transactions } = this.state;
        const transaction = transactions.find(t => t.id === transactionId);
        // This is a deficiency of this API, need to fix. It
        // assumes that it receives a serialized transaction,
        // but we only have access to the raw transaction
        this.onEdit(serializeTransaction(transaction, dateFormat), name, value);
      },
    });
  };

  onDelete = () => {
    const onConfirmDelete = () => {
      this.props.onDelete();

      const { transactions } = this.state;
      const [transaction, ..._childTransactions] = transactions;
      const { account: accountId } = transaction;
      if (accountId) {
        this.props.navigate(`/accounts/${accountId}`, { replace: true });
      } else {
        this.props.navigate(-1);
      }
    };

    const { transactions } = this.state;
    const [transaction] = transactions;

    if (transaction.reconciled) {
      this.props.pushModal('confirm-transaction-edit', {
        onConfirm: onConfirmDelete,
        confirmReason: 'deleteReconciled',
      });
    } else {
      onConfirmDelete();
    }
  };

  render() {
    const { adding, categories, accounts, payees } = this.props;
    const transactions = this.serializeTransactions(
      this.state.transactions || [],
    );
    const [transaction, ..._childTransactions] = transactions;
    const { payee: payeeId, category, account: accountId } = transaction;

    // Child transactions should always default to the signage
    // of the parent transaction
    // const forcedSign = transaction.amount < 0 ? 'negative' : 'positive';

    const account = getAccountsById(accounts)[accountId];
    const isOffBudget = account && !!account.offbudget;
    const payee = payees && payeeId && getPayeesById(payees)[payeeId];
    const transferAcct =
      payee &&
      payee.transfer_acct &&
      getAccountsById(accounts)[payee.transfer_acct];
    const isBudgetTransfer = transferAcct && !transferAcct.offbudget;
    const descriptionPretty = getDescriptionPretty(
      transaction,
      payee,
      transferAcct,
    );

    const transactionDate = parseDate(
      transaction.date,
      this.props.dateFormat,
      new Date(),
    );
    const dateDefaultValue = monthUtils.dayFromDate(transactionDate);

    return (
      <Page
        title={
          payeeId == null
            ? adding
              ? 'New Transaction'
              : 'Transaction'
            : descriptionPretty
        }
        titleStyle={{
          fontSize: 16,
          fontWeight: 500,
        }}
        style={{
          flex: 1,
          backgroundColor: theme.mobilePageBackground,
        }}
        headerLeftContent={<MobileBackButton />}
        footer={
          <View
            style={{
              paddingLeft: styles.mobileEditingPadding,
              paddingRight: styles.mobileEditingPadding,
              paddingTop: 10,
              paddingBottom: 10,
              backgroundColor: theme.tableHeaderBackground,
              borderTopWidth: 1,
              borderColor: theme.tableBorder,
            }}
          >
            {adding ? (
              <Button style={{ height: 40 }} onClick={() => this.onAdd()}>
                <SvgAdd
                  width={17}
                  height={17}
                  style={{ color: theme.formLabelText }}
                />
                <Text
                  style={{
                    ...styles.text,
                    color: theme.formLabelText,
                    marginLeft: 5,
                  }}
                >
                  Add transaction
                </Text>
              </Button>
            ) : (
              <Button style={{ height: 40 }} onClick={() => this.onSave()}>
                <SvgPencilWriteAlternate
                  style={{
                    width: 16,
                    height: 16,
                    color: theme.formInputText,
                  }}
                />
                <Text
                  style={{
                    ...styles.text,
                    marginLeft: 6,
                    color: theme.formInputText,
                  }}
                >
                  Save changes
                </Text>
              </Button>
            )}
          </View>
        }
        padding={0}
      >
        <View style={{ flexShrink: 0, marginTop: 20, marginBottom: 20 }}>
          <View
            style={{
              alignItems: 'center',
            }}
          >
            <FieldLabel
              title="Amount"
              flush
              style={{ marginBottom: 0, paddingLeft: 0 }}
            />
            <FocusableAmountInput
              ref={el => (this.amount = el)}
              value={transaction.amount}
              zeroIsNegative={true}
              onBlur={value =>
                this.onEdit(transaction, 'amount', value.toString())
              }
              onChange={value =>
                this.onQueueChange(transaction, 'amount', value)
              }
              style={{ transform: [] }}
              focusedStyle={{
                width: 'auto',
                padding: '5px',
                paddingLeft: '20px',
                paddingRight: '20px',
                minWidth: 120,
                transform: [{ translateY: -0.5 }],
              }}
              textStyle={{ fontSize: 30, textAlign: 'center' }}
            />
          </View>

          <View>
            <FieldLabel title="Payee" />
            <TapField
              value={descriptionPretty}
              onClick={() => this.onClick(transaction.id, 'payee')}
              data-testid="payee-field"
            />
          </View>

          <View>
            <FieldLabel
              title={transaction.is_parent ? 'Categories (split)' : 'Category'}
            />
            {!transaction.is_parent ? (
              <TapField
                style={{
                  ...((isBudgetTransfer || isOffBudget) && {
                    fontStyle: 'italic',
                    color: theme.pageTextSubdued,
                    fontWeight: 300,
                  }),
                }}
                value={
                  isOffBudget
                    ? 'Off Budget'
                    : isBudgetTransfer
                    ? 'Transfer'
                    : lookupName(categories, category)
                }
                disabled={isBudgetTransfer || isOffBudget}
                // TODO: the button to turn this transaction into a split
                // transaction was on top of the category button in the native
                // app, on the right-hand side
                //
                // On the web this doesn't work well and react gets upset if
                // nest a button in a button.
                //
                // rightContent={
                //   <Button
                //     contentStyle={{
                //       paddingVertical: 4,
                //       paddingHorizontal: 15,
                //       margin: 0,
                //     }}
                //     onPress={this.onSplit}
                //   >
                //     Split
                //   </Button>
                // }
                onClick={() => this.onClick(transaction.id, 'category')}
                data-testid="category-field"
              />
            ) : (
              <Text style={{ paddingLeft: styles.mobileEditingPadding }}>
                Split transaction editing is not supported on mobile at this
                time.
              </Text>
            )}
          </View>

          <View>
            <FieldLabel title="Account" />
            <TapField
              disabled={!adding}
              value={account ? account.name : null}
              onClick={() => this.onClick(transaction.id, 'account')}
              data-testid="account-field"
            />
          </View>

          <View style={{ flexDirection: 'row' }}>
            <View style={{ flex: 1 }}>
              <FieldLabel title="Date" />
              <InputField
                type="date"
                required
                style={{ color: theme.tableText, minWidth: '150px' }}
                defaultValue={dateDefaultValue}
                onUpdate={value =>
                  this.onEdit(
                    transaction,
                    'date',
                    formatDate(parseISO(value), this.props.dateFormat),
                  )
                }
                onChange={e =>
                  this.onQueueChange(
                    transaction,
                    'date',
                    formatDate(parseISO(e.target.value), this.props.dateFormat),
                  )
                }
              />
            </View>
            {transaction.reconciled ? (
              <View style={{ marginLeft: 0, marginRight: 8 }}>
                <FieldLabel title="Reconciled" />
                <BooleanField
                  checked
                  style={{
                    margin: 'auto',
                    width: 22,
                    height: 22,
                  }}
                  disabled
                />
              </View>
            ) : (
              <View style={{ marginLeft: 0, marginRight: 8 }}>
                <FieldLabel title="Cleared" />
                <BooleanField
                  checked={transaction.cleared}
                  onUpdate={checked =>
                    this.onEdit(transaction, 'cleared', checked)
                  }
                  style={{
                    margin: 'auto',
                    width: 22,
                    height: 22,
                  }}
                />
              </View>
            )}
          </View>

          <View>
            <FieldLabel title="Notes" />
            <InputField
              defaultValue={transaction.notes}
              onUpdate={value => this.onEdit(transaction, 'notes', value)}
              onChange={e =>
                this.onQueueChange(transaction, 'notes', e.target.value)
              }
            />
          </View>

          {!adding && (
            <View style={{ alignItems: 'center' }}>
              <Button
                onClick={() => this.onDelete()}
                style={{
                  height: 40,
                  borderWidth: 0,
                  marginLeft: styles.mobileEditingPadding,
                  marginRight: styles.mobileEditingPadding,
                  marginTop: 10,
                  backgroundColor: 'transparent',
                }}
                type="bare"
              >
                <SvgTrash
                  width={17}
                  height={17}
                  style={{ color: theme.errorText }}
                />
                <Text
                  style={{
                    color: theme.errorText,
                    marginLeft: 5,
                    userSelect: 'none',
                  }}
                >
                  Delete transaction
                </Text>
              </Button>
            </View>
          )}
        </View>
      </Page>
    );
  }
}

function isTemporary(transaction) {
  return transaction.id.indexOf('temp') === 0;
}

function makeTemporaryTransactions(currentAccountId, lastDate) {
  return [
    {
      id: 'temp',
      date: lastDate || monthUtils.currentDay(),
      account: currentAccountId,
      amount: 0,
      cleared: false,
    },
  ];
}

function TransactionEditUnconnected(props) {
  const { categories, accounts, payees, lastTransaction, dateFormat } = props;
  const { id: accountId, transactionId } = useParams();
  const navigate = useNavigate();
  const [fetchedTransactions, setFetchedTransactions] = useState(null);
  let transactions = [];
  let adding = false;
  let deleted = false;
  useSetThemeColor(theme.mobileViewTheme);

  useEffect(() => {
    // May as well update categories / accounts when transaction ID changes
    props.getCategories();
    props.getAccounts();
    props.getPayees();

    async function fetchTransaction() {
      let transactions = [];
      if (transactionId) {
        // Query for the transaction based on the ID with grouped splits.
        //
        // This means if the transaction in question is a split transaction, its
        // subtransactions will be returned in the `substransactions` property on
        // the parent transaction.
        //
        // The edit item components expect to work with a flat array of
        // transactions when handling splits, so we call ungroupTransactions to
        // flatten parent and children into one array.
        const { data } = await runQuery(
          q('transactions')
            .filter({ id: transactionId })
            .select('*')
            .options({ splits: 'grouped' }),
        );
        transactions = ungroupTransactions(data);
        setFetchedTransactions(transactions);
      }
    }
    fetchTransaction();
  }, [transactionId]);

  if (
    categories.length === 0 ||
    accounts.length === 0 ||
    (transactionId && !fetchedTransactions)
  ) {
    return null;
  }

  if (!transactionId) {
    transactions = makeTemporaryTransactions(
      accountId || (lastTransaction && lastTransaction.account) || null,
      lastTransaction && lastTransaction.date,
    );
    adding = true;
  } else {
    transactions = fetchedTransactions;
  }

  const onEdit = async transaction => {
    // Run the rules to auto-fill in any data. Right now we only do
    // this on new transactions because that's how desktop works.
    if (isTemporary(transaction)) {
      const afterRules = await send('rules-run', { transaction });
      const diff = getChangedValues(transaction, afterRules);

      const newTransaction = { ...transaction };
      if (diff) {
        Object.keys(diff).forEach(field => {
          if (newTransaction[field] == null) {
            newTransaction[field] = diff[field];
          }
        });
      }
      return newTransaction;
    }

    return transaction;
  };

  const onSave = async newTransactions => {
    if (deleted) {
      return;
    }

    const changes = diffItems(transactions || [], newTransactions);
    if (
      changes.added.length > 0 ||
      changes.updated.length > 0 ||
      changes.deleted.length
    ) {
      const _remoteUpdates = await send('transactions-batch-update', {
        added: changes.added,
        deleted: changes.deleted,
        updated: changes.updated,
      });

      // if (onTransactionsChange) {
      //   onTransactionsChange({
      //     ...changes,
      //     updated: changes.updated.concat(remoteUpdates),
      //   });
      // }
    }

    if (adding) {
      // The first one is always the "parent" and the only one we care
      // about
      props.setLastTransaction(newTransactions[0]);
    }
  };

  const onDelete = async () => {
    if (adding) {
      // Adding a new transactions, this disables saving when the component unmounts
      deleted = true;
    } else {
      const changes = { deleted: transactions };
      const _remoteUpdates = await send('transactions-batch-update', changes);
      // if (onTransactionsChange) {
      //   onTransactionsChange({ ...changes, updated: remoteUpdates });
      // }
    }
  };

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.pageBackground,
      }}
    >
      <TransactionEditInner
        transactions={transactions}
        adding={adding}
        categories={categories}
        accounts={accounts}
        payees={payees}
        pushModal={props.pushModal}
        navigate={navigate}
        // TODO: ChildEdit is complicated and heavily relies on RN
        // renderChildEdit={props => <ChildEdit {...props} />}
        renderChildEdit={props => {}}
        dateFormat={dateFormat}
        // TODO: was this a mistake in the original code?
        // onTapField={this.onTapField}
        onEdit={onEdit}
        onSave={onSave}
        onDelete={onDelete}
      />
    </View>
  );
}

export const TransactionEdit = props => {
  const { list: categories } = useCategories();
  const payees = useSelector(state => state.queries.payees);
  const lastTransaction = useSelector(state => state.queries.lastTransaction);
  const accounts = useSelector(state => state.queries.accounts);
  const dateFormat = useSelector(
    state => state.prefs.local.dateFormat || 'MM/dd/yyyy',
  );
  const actions = useActions();

  return (
    <TransactionEditUnconnected
      {...props}
      {...actions}
      categories={categories}
      payees={payees}
      lastTransaction={lastTransaction}
      accounts={accounts}
      dateFormat={dateFormat}
    />
  );
};

class Transaction extends PureComponent {
  render() {
    const {
      transaction,
      accounts,
      categories,
      payees,
      showCategory,
      added,
      onSelect,
      style,
    } = this.props;
    const {
      id,
      payee: payeeId,
      amount: originalAmount,
      category,
      cleared,
      is_parent,
      notes,
      schedule,
    } = transaction;

    let amount = originalAmount;
    if (isPreviewId(id)) {
      amount = getScheduledAmount(amount);
    }

    const categoryName = lookupName(categories, category);

    const payee = payees && payeeId && getPayeesById(payees)[payeeId];
    const transferAcct =
      payee &&
      payee.transfer_acct &&
      getAccountsById(accounts)[payee.transfer_acct];

    const prettyDescription = getDescriptionPretty(
      transaction,
      payee,
      transferAcct,
    );
    const prettyCategory = transferAcct
      ? 'Transfer'
      : is_parent
      ? 'Split'
      : categoryName;

    const isPreview = isPreviewId(id);
    const isReconciled = transaction.reconciled;
    const textStyle = isPreview && {
      fontStyle: 'italic',
      color: theme.pageTextLight,
    };

    return (
      <Button
        onClick={() => onSelect(transaction)}
        style={{
          backgroundColor: theme.tableBackground,
          border: 'none',
          width: '100%',
        }}
      >
        <ListItem
          style={{
            flex: 1,
            height: 60,
            padding: '5px 10px', // remove padding when Button is back
            ...(isPreview && {
              backgroundColor: theme.tableRowHeaderBackground,
            }),
            ...style,
          }}
        >
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {schedule && (
                <ArrowsSynchronize
                  style={{
                    width: 12,
                    height: 12,
                    marginRight: 5,
                    color: textStyle.color || theme.menuItemText,
                  }}
                />
              )}
              <TextOneLine
                style={{
                  ...styles.text,
                  ...textStyle,
                  fontSize: 14,
                  fontWeight: added ? '600' : '400',
                  ...(prettyDescription === '' && {
                    color: theme.tableTextLight,
                    fontStyle: 'italic',
                  }),
                }}
              >
                {prettyDescription || 'Empty'}
              </TextOneLine>
            </View>
            {isPreview ? (
              <Status status={notes} />
            ) : (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginTop: 3,
                }}
              >
                {isReconciled ? (
                  <Lock
                    style={{
                      width: 11,
                      height: 11,
                      color: theme.noticeTextLight,
                      marginRight: 5,
                    }}
                  />
                ) : (
                  <CheckCircle1
                    style={{
                      width: 11,
                      height: 11,
                      color: cleared
                        ? theme.noticeTextLight
                        : theme.pageTextSubdued,
                      marginRight: 5,
                    }}
                  />
                )}
                {showCategory && (
                  <TextOneLine
                    style={{
                      fontSize: 11,
                      marginTop: 1,
                      fontWeight: '400',
                      color: prettyCategory
                        ? theme.tableTextSelected
                        : theme.menuItemTextSelected,
                      fontStyle: prettyCategory ? null : 'italic',
                      textAlign: 'left',
                    }}
                  >
                    {prettyCategory || 'Uncategorized'}
                  </TextOneLine>
                )}
              </View>
            )}
          </View>
          <Text
            style={{
              ...styles.text,
              ...textStyle,
              marginLeft: 25,
              marginRight: 5,
              fontSize: 14,
            }}
          >
            {integerToCurrency(amount)}
          </Text>
        </ListItem>
      </Button>
    );
  }
}

export class TransactionList extends Component {
  makeData = memoizeOne(transactions => {
    // Group by date. We can assume transactions is ordered
    const sections = [];
    transactions.forEach(transaction => {
      if (
        sections.length === 0 ||
        transaction.date !== sections[sections.length - 1].date
      ) {
        // Mark the last transaction in the section so it can render
        // with a different border
        const lastSection = sections[sections.length - 1];
        if (lastSection && lastSection.data.length > 0) {
          const lastData = lastSection.data;
          lastData[lastData.length - 1].isLast = true;
        }

        sections.push({
          id: `${isPreviewId(transaction.id) ? 'preview/' : ''}${
            transaction.date
          }`,
          date: transaction.date,
          data: [],
        });
      }

      if (!transaction.is_child) {
        sections[sections.length - 1].data.push(transaction);
      }
    });
    return sections;
  });

  render() {
    const { transactions, scrollProps = {}, onLoadMore } = this.props;

    const sections = this.makeData(transactions);

    return (
      <>
        {scrollProps.ListHeaderComponent}
        <ListBox
          {...scrollProps}
          aria-label="transaction list"
          label=""
          loadMore={onLoadMore}
          selectionMode="none"
        >
          {sections.length === 0 ? (
            <Section>
              <Item textValue="No transactions">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    width: '100%',
                    backgroundColor: theme.mobilePageBackground,
                  }}
                >
                  <Text style={{ fontSize: 15 }}>No transactions</Text>
                </div>
              </Item>
            </Section>
          ) : null}
          {sections.map(section => {
            return (
              <Section
                title={
                  <span>
                    {monthUtils.format(section.date, 'MMMM dd, yyyy')}
                  </span>
                }
                key={section.id}
              >
                {section.data.map((transaction, index, transactions) => {
                  return (
                    <Item
                      key={transaction.id}
                      style={{
                        fontSize:
                          index === transactions.length - 1 ? 98 : 'inherit',
                      }}
                      textValue={transaction.id}
                    >
                      <Transaction
                        transaction={transaction}
                        categories={this.props.categories}
                        accounts={this.props.accounts}
                        payees={this.props.payees}
                        showCategory={this.props.showCategory}
                        added={this.props.isNew(transaction.id)}
                        onSelect={this.props.onSelect} // onSelect(transaction)}
                      />
                    </Item>
                  );
                })}
              </Section>
            );
          })}
        </ListBox>
      </>
    );
  }
}

function ListBox(props) {
  const state = useListState(props);
  const listBoxRef = useRef();
  const { listBoxProps, labelProps } = useListBox(props, state, listBoxRef);

  useEffect(() => {
    function loadMoreTransactions() {
      if (
        Math.abs(
          listBoxRef.current.scrollHeight -
            listBoxRef.current.clientHeight -
            listBoxRef.current.scrollTop,
        ) < listBoxRef.current.clientHeight // load more when we're one screen height from the end
      ) {
        props.loadMore();
      }
    }

    listBoxRef.current.addEventListener('scroll', loadMoreTransactions);

    return () => {
      listBoxRef.current?.removeEventListener('scroll', loadMoreTransactions);
    };
  }, [state.collection]);

  return (
    <>
      <div {...labelProps}>{props.label}</div>
      <ul
        {...listBoxProps}
        ref={listBoxRef}
        style={{
          padding: 0,
          listStyle: 'none',
          margin: 0,
          width: '100%',
        }}
      >
        {[...state.collection].map(item => (
          <ListBoxSection key={item.key} section={item} state={state} />
        ))}
      </ul>
    </>
  );
}

function ListBoxSection({ section, state }) {
  const { itemProps, headingProps, groupProps } = useListBoxSection({
    heading: section.rendered,
    'aria-label': section['aria-label'],
  });

  // The heading is rendered inside an <li> element, which contains
  // a <ul> with the child items.
  return (
    <li {...itemProps} style={{ width: '100%' }}>
      {section.rendered && (
        <div
          {...headingProps}
          className={`${css(styles.smallText, {
            backgroundColor: theme.pageBackground,
            borderBottom: `1px solid ${theme.tableBorder}`,
            borderTop: `1px solid ${theme.tableBorder}`,
            color: theme.tableHeaderText,
            display: 'flex',
            justifyContent: 'center',
            paddingBottom: 4,
            paddingTop: 4,
            position: 'sticky',
            top: '0',
            width: '100%',
            zIndex: zIndices.SECTION_HEADING,
          })}`}
        >
          {section.rendered}
        </div>
      )}
      <ul
        {...groupProps}
        style={{
          padding: 0,
          listStyle: 'none',
        }}
      >
        {[...section.childNodes].map((node, index, nodes) => (
          <Option
            key={node.key}
            item={node}
            state={state}
            isLast={index === nodes.length - 1}
          />
        ))}
      </ul>
    </li>
  );
}

function Option({ isLast, item, state }) {
  // Get props for the option element
  const ref = useRef();
  const { optionProps, isSelected } = useOption({ key: item.key }, state, ref);

  // Determine whether we should show a keyboard
  // focus ring for accessibility
  const { isFocusVisible, focusProps } = useFocusRing();

  return (
    <li
      {...mergeProps(optionProps, focusProps)}
      ref={ref}
      style={{
        background: isSelected
          ? theme.tableRowBackgroundHighlight
          : theme.tableBackground,
        color: isSelected ? theme.mobileModalText : null,
        outline: isFocusVisible ? '2px solid orange' : 'none',
        ...(!isLast && { borderBottom: `1px solid ${theme.tableBorder}` }),
      }}
    >
      {item.rendered}
    </li>
  );
}

const ROW_HEIGHT = 50;

const ListItem = forwardRef(({ children, style, ...props }, ref) => {
  return (
    <View
      style={{
        height: ROW_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 10,
        paddingRight: 10,
        ...style,
      }}
      ref={ref}
      {...props}
    >
      {children}
    </View>
  );
});