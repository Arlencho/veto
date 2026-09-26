/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/veto.json`.
 */
export type Veto = {
  "address": "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  "metadata": {
    "name": "veto",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Mandate enforcement for agent spending"
  },
  "instructions": [
    {
      "name": "applyChange",
      "docs": [
        "Apply a loosening change once the chain clock reaches `effective_at`."
      ],
      "discriminator": [
        248,
        177,
        9,
        41,
        50,
        98,
        255,
        50
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "cancelChange",
      "docs": [
        "Drop a loosening change. Owner or guardian."
      ],
      "discriminator": [
        100,
        30,
        4,
        148,
        3,
        244,
        243,
        168
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "charge",
      "docs": [
        "Submit a charge. Signed by the agent, decided by this program.",
        "",
        "Returns Ok whether the charge is paid or refused. See the module doc",
        "for why a refusal must not be an error."
      ],
      "discriminator": [
        26,
        55,
        197,
        209,
        93,
        77,
        242,
        15
      ],
      "accounts": [
        {
          "name": "agent",
          "docs": [
            "The agent holds authority and nothing else. It is not the owner, it",
            "pays only the transaction fee, and it cannot change any limit."
          ],
          "signer": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "mandate",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "closeHoldVault",
      "docs": [
        "Close an idle, unfrozen vault to its stored safe address."
      ],
      "discriminator": [
        44,
        82,
        147,
        65,
        191,
        42,
        43,
        216
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          },
          "relations": [
            "vault"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "closeMandate",
      "docs": [
        "Reclaim rent once a mandate is finished. Only the owner, never while active."
      ],
      "discriminator": [
        117,
        87,
        189,
        5,
        254,
        125,
        248,
        180
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "mandate",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "closeTradeRule",
      "docs": [
        "Reclaim rent once a trade rule is finished or past expiry, and revoke",
        "any delegation the source still gives the rule."
      ],
      "discriminator": [
        93,
        102,
        200,
        106,
        195,
        121,
        250,
        120
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "rule"
          ]
        },
        {
          "name": "rule",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "rule"
              }
            ]
          }
        },
        {
          "name": "source",
          "docs": [
            "still a token account delegated to this rule, close revokes that."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "deposit",
      "docs": [
        "Move tokens into the vault token account."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          },
          "relations": [
            "vault"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "execute",
      "docs": [
        "Pay a held withdrawal once the chain clock reaches its unlock time."
      ],
      "discriminator": [
        130,
        221,
        242,
        154,
        13,
        193,
        189,
        29
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          },
          "relations": [
            "vault"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "freeze",
      "docs": [
        "Block every outflow except `recover`. Owner or guardian."
      ],
      "discriminator": [
        255,
        91,
        207,
        84,
        251,
        194,
        254,
        63
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "grantOverride",
      "docs": [
        "Let one specific charge through above the per-payment ceiling.",
        "",
        "The owner signs, so the override is explicit. It is written to the",
        "ledger, so it is on the record. It raises the per-payment ceiling only:",
        "the total cap stays absolute."
      ],
      "discriminator": [
        225,
        146,
        123,
        110,
        56,
        16,
        99,
        141
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "mandate",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "grantTradeOverride",
      "docs": [
        "Raise the per-trade ceiling for one nonce. The daily limit and the cap stay put."
      ],
      "discriminator": [
        133,
        223,
        203,
        45,
        174,
        92,
        157,
        151
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "rule"
          ]
        },
        {
          "name": "rule",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "rule"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "amountIn",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initVault",
      "docs": [
        "Open a Hold vault. The vault PDA is the authority of its token account."
      ],
      "discriminator": [
        77,
        79,
        85,
        150,
        33,
        217,
        52,
        106
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "args.vaultId"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initVaultArgs"
            }
          }
        }
      ]
    },
    {
      "name": "migrateHoldVault",
      "docs": [
        "Upgrade the previous Hold layout without relaxing any stored rule."
      ],
      "discriminator": [
        223,
        75,
        49,
        252,
        155,
        82,
        164,
        36
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "openMandate",
      "docs": [
        "Open a mandate and delegate `cap` to it in the same transaction, so the",
        "owner signs exactly once."
      ],
      "discriminator": [
        116,
        145,
        190,
        28,
        86,
        223,
        105,
        74
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "mandate",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  110,
                  100,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "args.mandateId"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true
        },
        {
          "name": "mint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "openMandateArgs"
            }
          }
        }
      ]
    },
    {
      "name": "openTradeRule",
      "docs": [
        "Open a trade rule and delegate `cap` of the input token account to it."
      ],
      "discriminator": [
        109,
        183,
        63,
        166,
        60,
        202,
        82,
        15
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "rule",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "args.ruleId"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "rule"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true
        },
        {
          "name": "destination"
        },
        {
          "name": "inMint"
        },
        {
          "name": "outMint"
        },
        {
          "name": "exchangeProgram"
        },
        {
          "name": "pool"
        },
        {
          "name": "poolAuthority"
        },
        {
          "name": "poolInVault"
        },
        {
          "name": "poolOutVault"
        },
        {
          "name": "poolMint"
        },
        {
          "name": "poolFeeAccount"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "openTradeRuleArgs"
            }
          }
        }
      ]
    },
    {
      "name": "proposeChange",
      "docs": [
        "Tighten a rule now. A looser rule waits out the current delay."
      ],
      "discriminator": [
        167,
        211,
        18,
        222,
        93,
        215,
        74,
        159
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "values",
          "type": {
            "defined": {
              "name": "holdChange"
            }
          }
        }
      ]
    },
    {
      "name": "recover",
      "docs": [
        "Send the whole vault balance to the safe address. Works while frozen."
      ],
      "discriminator": [
        108,
        216,
        38,
        58,
        109,
        146,
        116,
        17
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          },
          "relations": [
            "vault"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "revokeMandate",
      "docs": [
        "Withdraw the agent's authority immediately, in one owner signature.",
        "",
        "Allowed from any status except already REVOKED, so an EXPIRED or",
        "EXHAUSTED mandate can still drop its SPL delegation. A second revoke",
        "is refused."
      ],
      "discriminator": [
        252,
        97,
        140,
        119,
        67,
        43,
        177,
        108
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "mandate",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "revokeTradeRule",
      "docs": [
        "Withdraw the agent's authority. Allowed from any status except revoked."
      ],
      "discriminator": [
        112,
        252,
        178,
        223,
        55,
        115,
        217,
        201
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "rule"
          ]
        },
        {
          "name": "rule",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "rule"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true,
          "relations": [
            "rule"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "skip",
      "docs": [
        "Pay a held withdrawal before its unlock time. Both keys, and not while frozen."
      ],
      "discriminator": [
        154,
        63,
        181,
        53,
        19,
        26,
        117,
        45
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "guardian",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          },
          "relations": [
            "vault"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "stop",
      "docs": [
        "Cancel one held withdrawal. Owner or guardian, with no wait."
      ],
      "discriminator": [
        42,
        133,
        32,
        60,
        171,
        253,
        184,
        155
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "trade",
      "docs": [
        "Sell `amount_in` of the pinned input through the pinned pool.",
        "",
        "Returns Ok whether the trade is filled or refused."
      ],
      "discriminator": [
        178,
        144,
        26,
        216,
        241,
        187,
        206,
        130
      ],
      "accounts": [
        {
          "name": "agent",
          "signer": true,
          "relations": [
            "rule"
          ]
        },
        {
          "name": "rule",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "rule"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true,
          "relations": [
            "rule"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "exchangeProgram"
        },
        {
          "name": "pool"
        },
        {
          "name": "poolAuthority"
        },
        {
          "name": "poolInVault",
          "writable": true
        },
        {
          "name": "poolOutVault",
          "writable": true
        },
        {
          "name": "poolMint",
          "writable": true
        },
        {
          "name": "poolFeeAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amountIn",
          "type": "u64"
        },
        {
          "name": "minOut",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "unfreeze",
      "docs": [
        "Clear a freeze. Both keys, or the owner alone after the delay when no guardian is set."
      ],
      "discriminator": [
        133,
        160,
        68,
        253,
        80,
        232,
        218,
        247
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "guardian",
          "signer": true,
          "optional": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "withdraw",
      "docs": [
        "Pay `amount` now when the rules allow it. Otherwise record a hold."
      ],
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          },
          "relations": [
            "vault"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "holdLedger",
      "discriminator": [
        195,
        103,
        143,
        50,
        70,
        255,
        84,
        161
      ]
    },
    {
      "name": "holdVault",
      "discriminator": [
        225,
        219,
        122,
        198,
        245,
        163,
        91,
        55
      ]
    },
    {
      "name": "ledger",
      "discriminator": [
        43,
        41,
        21,
        213,
        180,
        176,
        95,
        32
      ]
    },
    {
      "name": "mandate",
      "discriminator": [
        113,
        216,
        98,
        159,
        185,
        63,
        55,
        18
      ]
    },
    {
      "name": "tradeLedger",
      "discriminator": [
        200,
        191,
        201,
        165,
        93,
        179,
        79,
        190
      ]
    },
    {
      "name": "tradeRule",
      "discriminator": [
        71,
        199,
        163,
        41,
        101,
        116,
        241,
        212
      ]
    }
  ],
  "events": [
    {
      "name": "holdChangeApplied",
      "discriminator": [
        214,
        73,
        25,
        25,
        100,
        242,
        158,
        103
      ]
    },
    {
      "name": "holdChangeCancelled",
      "discriminator": [
        105,
        91,
        17,
        180,
        121,
        125,
        6,
        176
      ]
    },
    {
      "name": "holdChangeProposed",
      "discriminator": [
        10,
        12,
        18,
        221,
        178,
        129,
        99,
        89
      ]
    },
    {
      "name": "holdClosed",
      "discriminator": [
        111,
        175,
        192,
        227,
        192,
        83,
        108,
        99
      ]
    },
    {
      "name": "holdDeposited",
      "discriminator": [
        14,
        183,
        196,
        175,
        23,
        89,
        172,
        201
      ]
    },
    {
      "name": "holdExecuted",
      "discriminator": [
        0,
        66,
        40,
        156,
        42,
        195,
        127,
        203
      ]
    },
    {
      "name": "holdFrozen",
      "discriminator": [
        109,
        125,
        222,
        166,
        136,
        63,
        153,
        164
      ]
    },
    {
      "name": "holdHeld",
      "discriminator": [
        213,
        77,
        28,
        129,
        215,
        57,
        137,
        224
      ]
    },
    {
      "name": "holdMigrated",
      "discriminator": [
        32,
        149,
        140,
        45,
        3,
        28,
        129,
        197
      ]
    },
    {
      "name": "holdOpened",
      "discriminator": [
        43,
        30,
        161,
        191,
        183,
        229,
        201,
        113
      ]
    },
    {
      "name": "holdPaid",
      "discriminator": [
        75,
        217,
        168,
        36,
        135,
        161,
        113,
        223
      ]
    },
    {
      "name": "holdRecovered",
      "discriminator": [
        26,
        178,
        12,
        148,
        227,
        199,
        14,
        232
      ]
    },
    {
      "name": "holdRefused",
      "discriminator": [
        154,
        131,
        154,
        169,
        135,
        21,
        58,
        52
      ]
    },
    {
      "name": "holdSkipped",
      "discriminator": [
        26,
        204,
        98,
        122,
        152,
        219,
        27,
        65
      ]
    },
    {
      "name": "holdStopped",
      "discriminator": [
        204,
        29,
        182,
        240,
        51,
        231,
        188,
        149
      ]
    },
    {
      "name": "holdUnfreezeScheduled",
      "discriminator": [
        158,
        133,
        180,
        244,
        162,
        69,
        74,
        117
      ]
    },
    {
      "name": "holdUnfrozen",
      "discriminator": [
        115,
        249,
        65,
        139,
        158,
        138,
        7,
        112
      ]
    },
    {
      "name": "paid",
      "discriminator": [
        240,
        193,
        17,
        238,
        238,
        210,
        129,
        235
      ]
    },
    {
      "name": "refused",
      "discriminator": [
        230,
        49,
        133,
        208,
        106,
        62,
        106,
        169
      ]
    },
    {
      "name": "tradeRefused",
      "discriminator": [
        97,
        219,
        5,
        169,
        115,
        219,
        109,
        235
      ]
    },
    {
      "name": "traded",
      "discriminator": [
        225,
        202,
        73,
        175,
        147,
        43,
        160,
        150
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "capMustBePositive",
      "msg": "cap must be greater than zero"
    },
    {
      "code": 6001,
      "name": "perTxMaxMustBePositive",
      "msg": "per-payment maximum must be greater than zero"
    },
    {
      "code": 6002,
      "name": "perTxMaxAboveCap",
      "msg": "per-payment maximum cannot exceed the cap"
    },
    {
      "code": 6003,
      "name": "expiryInThePast",
      "msg": "expiry must be in the future"
    },
    {
      "code": 6004,
      "name": "purposeTooLong",
      "msg": "purpose is longer than the on-chain limit"
    },
    {
      "code": 6005,
      "name": "merchantRequired",
      "msg": "a mandate must name the merchant it may pay"
    },
    {
      "code": 6006,
      "name": "agentMustNotBeOwner",
      "msg": "the agent key must not be the owner key"
    },
    {
      "code": 6007,
      "name": "sourceNotOwnedByOwner",
      "msg": "source token account is not owned by the mandate owner"
    },
    {
      "code": 6008,
      "name": "mintMismatch",
      "msg": "token mint does not match the mandate"
    },
    {
      "code": 6009,
      "name": "sourceMismatch",
      "msg": "source token account does not match the mandate"
    },
    {
      "code": 6010,
      "name": "ledgerMismatch",
      "msg": "ledger does not belong to this mandate"
    },
    {
      "code": 6011,
      "name": "notTheAgent",
      "msg": "signer is not the agent named in the mandate"
    },
    {
      "code": 6012,
      "name": "notTheOwner",
      "msg": "signer is not the owner of this mandate"
    },
    {
      "code": 6013,
      "name": "invalidMandatePda",
      "msg": "mandate address does not match its stored fields"
    },
    {
      "code": 6014,
      "name": "mandateNotActive",
      "msg": "mandate is not active"
    },
    {
      "code": 6015,
      "name": "mandateStillActive",
      "msg": "mandate is still active"
    },
    {
      "code": 6016,
      "name": "nonceRequired",
      "msg": "an override needs a non-zero nonce"
    },
    {
      "code": 6017,
      "name": "amountMustBePositive",
      "msg": "amount must be greater than zero"
    },
    {
      "code": 6018,
      "name": "overrideAboveCap",
      "msg": "an override cannot raise the total cap"
    },
    {
      "code": 6019,
      "name": "mathOverflow",
      "msg": "arithmetic overflow"
    },
    {
      "code": 6020,
      "name": "nonceAlreadySettled",
      "msg": "override nonce is at or below the last paid nonce"
    },
    {
      "code": 6021,
      "name": "delayNotAllowed",
      "msg": "delay must be 1, 2, or 3 days"
    },
    {
      "code": 6022,
      "name": "shareOutOfRange",
      "msg": "share must be between 0 and 10000 basis points"
    },
    {
      "code": 6023,
      "name": "safeAddressRequired",
      "msg": "safe address is required"
    },
    {
      "code": 6024,
      "name": "guardianIsOwner",
      "msg": "the guardian must be a different key from the owner"
    },
    {
      "code": 6025,
      "name": "positiveAmountRequired",
      "msg": "amount must be greater than zero"
    },
    {
      "code": 6026,
      "name": "holdMathOverflow",
      "msg": "arithmetic overflow"
    },
    {
      "code": 6027,
      "name": "notTheVaultOwner",
      "msg": "signer is not the owner of this vault"
    },
    {
      "code": 6028,
      "name": "notOwnerOrGuardian",
      "msg": "signer is not the owner or the guardian"
    },
    {
      "code": 6029,
      "name": "notTheGuardian",
      "msg": "signer is not the guardian"
    },
    {
      "code": 6030,
      "name": "bothKeysRequired",
      "msg": "both the owner and the guardian must sign"
    },
    {
      "code": 6031,
      "name": "invalidVaultPda",
      "msg": "vault address does not match its stored fields"
    },
    {
      "code": 6032,
      "name": "vaultTokenMismatch",
      "msg": "vault token account does not match the vault"
    },
    {
      "code": 6033,
      "name": "holdMintMismatch",
      "msg": "token mint does not match the vault"
    },
    {
      "code": 6034,
      "name": "holdSourceNotOwned",
      "msg": "source token account is not owned by the vault owner"
    },
    {
      "code": 6035,
      "name": "destinationIsVault",
      "msg": "destination is the vault token account"
    },
    {
      "code": 6036,
      "name": "destinationMismatch",
      "msg": "destination does not match the pending withdrawal"
    },
    {
      "code": 6037,
      "name": "notTheSafeAddress",
      "msg": "destination is not the safe address"
    },
    {
      "code": 6038,
      "name": "withdrawalNotPending",
      "msg": "withdrawal is not pending"
    },
    {
      "code": 6039,
      "name": "tooEarly",
      "msg": "the chain clock has not reached the unlock time"
    },
    {
      "code": 6040,
      "name": "vaultFrozen",
      "msg": "the vault is frozen"
    },
    {
      "code": 6041,
      "name": "notFrozen",
      "msg": "the vault is not frozen"
    },
    {
      "code": 6042,
      "name": "unfreezeNotReady",
      "msg": "unfreeze is still waiting on the chain clock"
    },
    {
      "code": 6043,
      "name": "changeAlreadyPending",
      "msg": "a loosening change is already pending"
    },
    {
      "code": 6044,
      "name": "noPendingChange",
      "msg": "there is no pending change"
    },
    {
      "code": 6045,
      "name": "changeNotReady",
      "msg": "the chain clock has not reached the change"
    },
    {
      "code": 6046,
      "name": "changeUnchanged",
      "msg": "the proposed values match the current rules"
    },
    {
      "code": 6047,
      "name": "nothingToRecover",
      "msg": "the vault token account is empty"
    },
    {
      "code": 6048,
      "name": "holdInsufficientFunds",
      "msg": "the vault cannot cover this withdrawal"
    },
    {
      "code": 6049,
      "name": "badVaultAuthority",
      "msg": "token account authority is not the vault"
    },
    {
      "code": 6050,
      "name": "invalidTradeRulePda",
      "msg": "trade rule address does not match its stored fields"
    },
    {
      "code": 6051,
      "name": "tradeDeltaMismatch",
      "msg": "the swap moved a different amount than the rule allowed"
    },
    {
      "code": 6052,
      "name": "poolAccountMismatch",
      "msg": "pool accounts do not match the trade rule"
    },
    {
      "code": 6053,
      "name": "tradeLimitsOutOfOrder",
      "msg": "per-trade maximum, daily limit, and cap are out of order"
    },
    {
      "code": 6054,
      "name": "floorDenominatorRequired",
      "msg": "floor denominator must be greater than zero"
    },
    {
      "code": 6055,
      "name": "exchangeNotSupported",
      "msg": "this exchange is not supported"
    },
    {
      "code": 6056,
      "name": "destinationNotOwnedByOwner",
      "msg": "destination token account is not owned by the rule owner"
    },
    {
      "code": 6057,
      "name": "unexpectedTradeAccount",
      "msg": "an extra account was passed to trade"
    },
    {
      "code": 6058,
      "name": "tradeRuleNotActive",
      "msg": "trade rule is not active"
    },
    {
      "code": 6059,
      "name": "tradeRuleStillActive",
      "msg": "trade rule is still active"
    },
    {
      "code": 6060,
      "name": "floorRequired",
      "msg": "floor numerator must be greater than zero"
    },
    {
      "code": 6061,
      "name": "dailyLimitRequired",
      "msg": "daily limit must be greater than zero"
    },
    {
      "code": 6062,
      "name": "sourceAlreadyDelegated",
      "msg": "source token account is already delegated to another account"
    },
    {
      "code": 6063,
      "name": "notATokenAccount",
      "msg": "account is not an initialized SPL token account"
    },
    {
      "code": 6064,
      "name": "invalidLegacyHoldLayout",
      "msg": "vault is not the supported legacy Hold layout"
    },
    {
      "code": 6065,
      "name": "holdWithdrawalPending",
      "msg": "a held withdrawal must be resolved before closing"
    },
    {
      "code": 6066,
      "name": "safeAddressIsGuardian",
      "msg": "safe address must differ from the guardian"
    },
    {
      "code": 6067,
      "name": "safeAddressIsOwner",
      "msg": "safe address must differ from the owner"
    }
  ],
  "types": [
    {
      "name": "entry",
      "docs": [
        "One decision, paid or refused, exactly as the program made it.",
        "",
        "`repr(C)` with explicit padding, because the ledger is a zero-copy account:",
        "the ring is larger than the BPF stack frame and must never be deserialized",
        "onto it."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "counterparty",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "suggestedOverride",
            "docs": [
              "For a refusal, the one-shot override that would have cleared this exact",
              "charge, or zero when no override could. A decline that tells you how to",
              "proceed is the difference between a limit and an answer."
            ],
            "type": "u64"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          }
        ]
      }
    },
    {
      "name": "holdChange",
      "docs": [
        "The desired rules, passed whole to `propose_change`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "delaySecs",
            "type": "i64"
          },
          {
            "name": "bigShareBps",
            "type": "u16"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "safeAddress",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdChangeApplied",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "fields",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "holdChangeCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdChangeProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          },
          {
            "name": "fields",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "holdClosed",
      "docs": [
        "Full token balance swept to the safe token account before closure."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "holdEntry",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "withdrawalId",
            "type": "u64"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          }
        ]
      }
    },
    {
      "name": "holdExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdFrozen",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "by",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdHeld",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "unlockAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "holdLedger",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "total",
            "type": "u32"
          },
          {
            "name": "head",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                1
              ]
            }
          },
          {
            "name": "entries",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "holdEntry"
                  }
                },
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "holdMigrated",
      "docs": [
        "Rent top-up in lamports. No vault tokens move during layout migration."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "safeAddress",
            "type": "pubkey"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "delaySecs",
            "type": "i64"
          },
          {
            "name": "bigShareBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "holdPaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdRecovered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdRefused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "reason",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "holdSkipped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdStopped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "holdUnfreezeScheduled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "holdUnfrozen",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdVault",
      "docs": [
        "Funds live in the vault token account. Its authority is this PDA, so a",
        "raw transfer signed by the owner or the guardian cannot move them."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "guardian",
            "docs": [
              "`Pubkey::default()` means no guardian is set."
            ],
            "type": "pubkey"
          },
          {
            "name": "safeAddress",
            "docs": [
              "Wallet that must own the token account `recover` pays."
            ],
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "vaultToken",
            "type": "pubkey"
          },
          {
            "name": "vaultId",
            "type": "u64"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "windowSpent",
            "docs": [
              "Unused legacy fixed-window fields, retained to preserve account layout."
            ],
            "type": "u64"
          },
          {
            "name": "windowStart",
            "type": "i64"
          },
          {
            "name": "delaySecs",
            "type": "i64"
          },
          {
            "name": "unfreezeAt",
            "docs": [
              "When no guardian is set, `unfreeze` arms this timestamp and finishes",
              "only once the chain clock reaches it. Zero means no unfreeze is waiting."
            ],
            "type": "i64"
          },
          {
            "name": "nextWithdrawalId",
            "type": "u64"
          },
          {
            "name": "bigShareBps",
            "type": "u16"
          },
          {
            "name": "frozen",
            "type": "bool"
          },
          {
            "name": "knownLen",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "tokenBump",
            "type": "u8"
          },
          {
            "name": "ledgerBump",
            "type": "u8"
          },
          {
            "name": "known",
            "type": {
              "array": [
                "pubkey",
                16
              ]
            }
          },
          {
            "name": "pending",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "pendingWithdrawal"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "change",
            "type": {
              "defined": {
                "name": "pendingChange"
              }
            }
          },
          {
            "name": "dailyBuckets",
            "docs": [
              "Rolling daily and share accounting, retaining the current and preceding 24 hours.",
              "Appended so all existing field offsets remain stable."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "tradeBucket"
                  }
                },
                25
              ]
            }
          }
        ]
      }
    },
    {
      "name": "initVaultArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vaultId",
            "type": "u64"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "safeAddress",
            "type": "pubkey"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "delaySecs",
            "type": "i64"
          },
          {
            "name": "bigShareBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "ledger",
      "docs": [
        "A ring of the most recent decisions. Refusals are recorded here with the",
        "same weight as payments, which is the point of the whole program.",
        "",
        "The ring is the authoritative recent window. Longer history is rebuilt by",
        "indexing `Paid` and `Refused` events from transaction logs, so a busy week",
        "wrapping the ring costs nothing."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mandate",
            "type": "pubkey"
          },
          {
            "name": "total",
            "docs": [
              "Total entries ever written, including those the ring has overwritten."
            ],
            "type": "u32"
          },
          {
            "name": "head",
            "docs": [
              "Index the next entry is written to."
            ],
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                1
              ]
            }
          },
          {
            "name": "entries",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "entry"
                  }
                },
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "mandate",
      "docs": [
        "A permission to spend, owned by the human and enforced by this program.",
        "",
        "The owner key never leaves Seed Vault and signs only `open_mandate`,",
        "`grant_override`, `revoke_mandate` and `close_mandate`. The agent key signs",
        "`charge` and can do nothing else: it cannot widen any limit, change the",
        "merchant, extend the expiry, or move funds outside this account's rules."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "Human who owns the funds and the mandate."
            ],
            "type": "pubkey"
          },
          {
            "name": "agent",
            "docs": [
              "Key allowed to submit charges. Holds authority, never ownership."
            ],
            "type": "pubkey"
          },
          {
            "name": "mint",
            "docs": [
              "Asset this mandate governs."
            ],
            "type": "pubkey"
          },
          {
            "name": "source",
            "docs": [
              "The owner's token account. Funds stay here until a charge is allowed."
            ],
            "type": "pubkey"
          },
          {
            "name": "merchant",
            "docs": [
              "The only wallet that may receive funds under this mandate."
            ],
            "type": "pubkey"
          },
          {
            "name": "mandateId",
            "docs": [
              "Distinguishes several mandates held by the same owner."
            ],
            "type": "u64"
          },
          {
            "name": "cap",
            "docs": [
              "Total that may ever be spent, in base units."
            ],
            "type": "u64"
          },
          {
            "name": "spent",
            "docs": [
              "Spent so far, in base units. Never exceeds `cap`."
            ],
            "type": "u64"
          },
          {
            "name": "perTxMax",
            "docs": [
              "Largest single payment allowed, in base units."
            ],
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Unix seconds after which nothing may be spent."
            ],
            "type": "i64"
          },
          {
            "name": "overrideAmount",
            "docs": [
              "One-shot allowance the owner granted for a specific charge."
            ],
            "type": "u64"
          },
          {
            "name": "overrideNonce",
            "docs": [
              "Nonce the override applies to. Zero means no override is pending."
            ],
            "type": "u64"
          },
          {
            "name": "lastNonce",
            "docs": [
              "Highest nonce that has been paid. Blocks replay of a settled charge."
            ],
            "type": "u64"
          },
          {
            "name": "purpose",
            "docs": [
              "What the money is for, in the owner's own words, fixed at creation."
            ],
            "type": "string"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "spendCount",
            "type": "u32"
          },
          {
            "name": "refusalCount",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "openMandateArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mandateId",
            "type": "u64"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "merchant",
            "type": "pubkey"
          },
          {
            "name": "cap",
            "type": "u64"
          },
          {
            "name": "perTxMax",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "purpose",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "openTradeRuleArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ruleId",
            "type": "u64"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "exchangeKind",
            "type": "u8"
          },
          {
            "name": "cap",
            "type": "u64"
          },
          {
            "name": "perTradeMax",
            "type": "u64"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "floorNum",
            "type": "u64"
          },
          {
            "name": "floorDen",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "purpose",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "paid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mandate",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "spent",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "pendingChange",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "fields",
            "docs": [
              "Which fields wait. See `CHANGE_*`."
            ],
            "type": "u8"
          },
          {
            "name": "bigShareBps",
            "type": "u16"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "delaySecs",
            "type": "i64"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "safeAddress",
            "type": "pubkey"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pendingWithdrawal",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "unlockAt",
            "type": "i64"
          },
          {
            "name": "status",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "refused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mandate",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "suggestedOverride",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tradeBucket",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "hour",
            "type": "i64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tradeEntry",
      "docs": [
        "One trade decision. `repr(C)` with explicit padding, because the ledger is",
        "zero-copy and the ring must never be deserialized onto the stack.",
        "",
        "`counterparty` is the pool on a paid trade and on most refusals. On reason",
        "11 or 12 it is the account the agent tried."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "amountIn",
            "type": "u64"
          },
          {
            "name": "amountOut",
            "type": "u64"
          },
          {
            "name": "minOut",
            "type": "u64"
          },
          {
            "name": "counterparty",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "suggestedOverride",
            "type": "u64"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          }
        ]
      }
    },
    {
      "name": "tradeLedger",
      "docs": [
        "A ring of the most recent trade decisions, including refusals."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rule",
            "type": "pubkey"
          },
          {
            "name": "total",
            "docs": [
              "Total entries ever written, including those the ring has overwritten."
            ],
            "type": "u32"
          },
          {
            "name": "head",
            "docs": [
              "Index the next entry is written to."
            ],
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                1
              ]
            }
          },
          {
            "name": "entries",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "tradeEntry"
                  }
                },
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "tradeRefused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rule",
            "type": "pubkey"
          },
          {
            "name": "amountIn",
            "type": "u64"
          },
          {
            "name": "minOut",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "suggestedOverride",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tradeRule",
      "docs": [
        "A permission to swap, owned by the human and enforced by this program.",
        "",
        "The owner signs `open_trade_rule`, `grant_trade_override`, `revoke_trade_rule`",
        "and `close_trade_rule`. The agent signs `trade` and can do nothing else."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "docs": [
              "Key allowed to submit trades. Holds authority, never ownership."
            ],
            "type": "pubkey"
          },
          {
            "name": "source",
            "docs": [
              "The owner's input token account. Delegated to this rule for `cap`."
            ],
            "type": "pubkey"
          },
          {
            "name": "destination",
            "docs": [
              "The owner's output token account, pinned at open."
            ],
            "type": "pubkey"
          },
          {
            "name": "inMint",
            "type": "pubkey"
          },
          {
            "name": "outMint",
            "type": "pubkey"
          },
          {
            "name": "exchangeProgram",
            "type": "pubkey"
          },
          {
            "name": "exchangeKind",
            "docs": [
              "0 is the SPL token-swap program named by `SPL_TOKEN_SWAP_ID`."
            ],
            "type": "u8"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "poolAuthority",
            "type": "pubkey"
          },
          {
            "name": "poolInVault",
            "type": "pubkey"
          },
          {
            "name": "poolOutVault",
            "type": "pubkey"
          },
          {
            "name": "poolMint",
            "type": "pubkey"
          },
          {
            "name": "poolFeeAccount",
            "docs": [
              "Stored at open and compared on every trade. The fee owner is not hardcoded."
            ],
            "type": "pubkey"
          },
          {
            "name": "ruleId",
            "type": "u64"
          },
          {
            "name": "cap",
            "docs": [
              "Total input that may ever be sold, in base units."
            ],
            "type": "u64"
          },
          {
            "name": "spent",
            "docs": [
              "Input sold so far, in base units. Never exceeds `cap`."
            ],
            "type": "u64"
          },
          {
            "name": "perTradeMax",
            "docs": [
              "Largest single trade allowed, in base units, before a one-shot override."
            ],
            "type": "u64"
          },
          {
            "name": "dailyLimit",
            "docs": [
              "Most input that may be sold in any rolling 24 hour interval."
            ],
            "type": "u64"
          },
          {
            "name": "dailyBuckets",
            "docs": [
              "Current hour plus the preceding 24 hours. This retains a partial oldest",
              "hour conservatively, so allowance may take up to 25 hours to recover."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "tradeBucket"
                  }
                },
                25
              ]
            }
          },
          {
            "name": "floorNum",
            "docs": [
              "Minimum output per unit of input, as `floor_num / floor_den`."
            ],
            "type": "u64"
          },
          {
            "name": "floorDen",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "overrideAmount",
            "docs": [
              "One-shot per-trade ceiling the owner granted for a specific nonce."
            ],
            "type": "u64"
          },
          {
            "name": "overrideNonce",
            "docs": [
              "Nonce the override applies to. Zero means no override is pending."
            ],
            "type": "u64"
          },
          {
            "name": "lastNonce",
            "docs": [
              "Highest nonce that has been traded. A refusal does not advance it."
            ],
            "type": "u64"
          },
          {
            "name": "purpose",
            "type": "string"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "tradeCount",
            "type": "u32"
          },
          {
            "name": "refusalCount",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "traded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rule",
            "type": "pubkey"
          },
          {
            "name": "amountIn",
            "type": "u64"
          },
          {
            "name": "amountOut",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "spent",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
