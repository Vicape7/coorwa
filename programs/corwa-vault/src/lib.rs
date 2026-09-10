#![allow(unexpected_cfgs)]
//! Corwa cashback vault.
//!
//! Corwa earns real revenue in exactly one place: MomoSwap pays a named referrer 20% of its 1%
//! curve fee. Accrual against that revenue is computed off chain, because it depends on prices and
//! on which wallet generated which fill. Custody of the money is not, because "trust our payout
//! wallet" is the part a user cannot check.
//!
//! So the split is deliberate. Corwa decides *who is owed what* and publishes it as a merkle root.
//! The chain decides *whether the money moves*, and it only ever moves to a wallet named in a
//! published root, signed for by that wallet itself.
//!
//! The load-bearing property is that there is no instruction that pays the authority. Tokens enter
//! through `fund` and leave through `claim`, and nothing else. Publishing an epoch reserves its
//! total against the vault's balance, so a published epoch is always already funded, and that
//! reserve is untouchable until either a claimant takes it or the claim window closes and it falls
//! back into the vault for the next epoch. An operator who walks away cannot take the float with
//! them; the worst they can do is stop publishing.
//!
//! Two consequences of that, stated plainly rather than hidden:
//!   - There is no withdrawal path at all. Tokens funded by mistake can only be routed back out by
//!     publishing an epoch that names the sender.
//!   - `close_epoch` is permissionless on purpose. If it needed the authority, a lost key would
//!     strand every unclaimed reserve forever.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("83cPao5iemCJ6dj9ni7KXGo7JCVHtQu2jfMVuD7ywdYg");

pub const VAULT_SEED: &[u8] = b"vault";
pub const FUNDS_SEED: &[u8] = b"funds";
pub const EPOCH_SEED: &[u8] = b"epoch";
pub const CLAIM_SEED: &[u8] = b"claim";

/// Leaves and internal nodes are hashed under different prefixes.
///
/// The tree pairs siblings in sorted order, which keeps proofs free of direction bits. That trade
/// is only safe while no internal node can ever be reinterpreted as a leaf, so the two are domain
/// separated here. Without these prefixes a 64-byte "leaf" could be forged to collide with a node.
pub const LEAF_PREFIX: u8 = 0x00;
pub const NODE_PREFIX: u8 = 0x01;

/// A proof this long covers 16.7M claimants. The cap exists so a caller cannot burn the compute
/// budget on an arbitrarily long walk.
pub const MAX_PROOF_LEN: usize = 24;

/// Shortest claim window we will accept, so an epoch cannot be published and closed in the same
/// breath.
pub const MIN_CLAIM_WINDOW: i64 = 24 * 60 * 60;

#[program]
pub mod corwa_vault {
    use super::*;

    /// Create the vault for one mint. One vault per mint, so its address is derivable from the
    /// mint alone and a client never has to be told where to look.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.mint = ctx.accounts.mint.key();
        vault.token_account = ctx.accounts.funds.key();
        vault.epoch_count = 0;
        vault.total_funded = 0;
        vault.total_claimed = 0;
        vault.reserved = 0;
        vault.bump = ctx.bumps.vault;
        vault.funds_bump = ctx.bumps.funds;

        emit!(VaultInitialized {
            vault: vault.key(),
            authority: vault.authority,
            mint: vault.mint,
        });
        Ok(())
    }

    /// Move tokens into the vault. Deliberately open to anyone: the vault has no withdrawal path,
    /// so funding it is a one-way gift to the claimants of future epochs, and gating it would buy
    /// nothing.
    pub fn fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::AmountZero);

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.funder_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.funds.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.total_funded = vault
            .total_funded
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        emit!(Funded {
            vault: vault.key(),
            funder: ctx.accounts.funder.key(),
            amount,
        });
        Ok(())
    }

    /// Publish one epoch of cashback.
    ///
    /// `total` is checked against the balance the vault holds free of earlier epochs, so an epoch
    /// can never promise money that is not already sitting there. That check is the whole reason a
    /// claimant does not have to trust the publisher: by the time they see a root, the tokens
    /// behind it are already reserved.
    pub fn publish_epoch(
        ctx: Context<PublishEpoch>,
        index: u64,
        root: [u8; 32],
        total: u64,
        claimants: u32,
        deadline: i64,
    ) -> Result<()> {
        require!(total > 0, VaultError::AmountZero);
        require!(claimants > 0, VaultError::AmountZero);
        require!(root != [0u8; 32], VaultError::EmptyRoot);

        let now = Clock::get()?.unix_timestamp;
        let earliest = now
            .checked_add(MIN_CLAIM_WINDOW)
            .ok_or(VaultError::MathOverflow)?;
        require!(deadline >= earliest, VaultError::ClaimWindowTooShort);

        let vault = &mut ctx.accounts.vault;
        require!(index == vault.epoch_count, VaultError::WrongEpochIndex);

        let unreserved = ctx
            .accounts
            .funds
            .amount
            .checked_sub(vault.reserved)
            .ok_or(VaultError::MathOverflow)?;
        require!(unreserved >= total, VaultError::InsufficientReserve);

        vault.reserved = vault
            .reserved
            .checked_add(total)
            .ok_or(VaultError::MathOverflow)?;
        vault.epoch_count = vault
            .epoch_count
            .checked_add(1)
            .ok_or(VaultError::MathOverflow)?;

        let vault_key = vault.key();
        let epoch = &mut ctx.accounts.epoch;
        epoch.vault = vault_key;
        epoch.index = index;
        epoch.root = root;
        epoch.total = total;
        epoch.claimed = 0;
        epoch.claimants = claimants;
        epoch.claimed_count = 0;
        epoch.published_at = now;
        epoch.deadline = deadline;
        epoch.closed = false;
        epoch.bump = ctx.bumps.epoch;

        emit!(EpochPublished {
            vault: vault_key,
            epoch: epoch.key(),
            index,
            root,
            total,
            claimants,
            deadline,
        });
        Ok(())
    }

    /// Take what a published root says you are owed.
    ///
    /// The claimant signs for themselves and the leaf commits to their own key, so a proof cannot
    /// be replayed on someone else's behalf and the tokens have nowhere to go but their own token
    /// account. The claim record is a fresh PDA, so a second attempt fails at account creation
    /// before any of this runs.
    pub fn claim(ctx: Context<Claim>, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        require!(amount > 0, VaultError::AmountZero);
        require!(proof.len() <= MAX_PROOF_LEN, VaultError::ProofTooLong);

        let now = Clock::get()?.unix_timestamp;
        let claimant = ctx.accounts.claimant.key();

        let epoch = &mut ctx.accounts.epoch;
        require!(!epoch.closed, VaultError::EpochClosed);
        require!(now <= epoch.deadline, VaultError::ClaimWindowClosed);

        let leaf = leaf_hash(epoch.index, &claimant, amount);
        require!(
            root_from_proof(leaf, &proof) == epoch.root,
            VaultError::InvalidProof
        );

        // A correct root can never oversubscribe its own total. Checking anyway keeps a publishing
        // mistake contained to its own epoch instead of eating the next epoch's reserve.
        epoch.claimed = epoch
            .claimed
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        require!(epoch.claimed <= epoch.total, VaultError::ExceedsEpochTotal);
        epoch.claimed_count = epoch
            .claimed_count
            .checked_add(1)
            .ok_or(VaultError::MathOverflow)?;

        let epoch_key = epoch.key();
        let epoch_index = epoch.index;

        let vault = &mut ctx.accounts.vault;
        vault.reserved = vault
            .reserved
            .checked_sub(amount)
            .ok_or(VaultError::MathOverflow)?;
        vault.total_claimed = vault
            .total_claimed
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        let status = &mut ctx.accounts.claim_status;
        status.epoch = epoch_key;
        status.claimant = claimant;
        status.amount = amount;
        status.claimed_at = now;
        status.bump = ctx.bumps.claim_status;

        let vault = &ctx.accounts.vault;
        let vault_key = vault.key();
        let mint_key = vault.mint;
        let vault_bump = vault.bump;
        let signer_seeds: &[&[u8]] = &[VAULT_SEED, mint_key.as_ref(), &[vault_bump]];

        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.funds.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.claimant_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(Claimed {
            vault: vault_key,
            epoch: epoch_key,
            index: epoch_index,
            claimant,
            amount,
        });
        Ok(())
    }

    /// Retire an epoch once its window has passed and return whatever went unclaimed to the
    /// vault's free balance, where the next epoch can hand it out again.
    ///
    /// Anyone may call this. It cannot move a token anywhere, it only lets the vault stop counting
    /// an expired promise, so putting a key in front of it would add a failure mode and nothing
    /// else.
    pub fn close_epoch(ctx: Context<CloseEpoch>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;

        let epoch = &mut ctx.accounts.epoch;
        require!(!epoch.closed, VaultError::EpochClosed);
        require!(now > epoch.deadline, VaultError::ClaimWindowOpen);

        let unclaimed = epoch
            .total
            .checked_sub(epoch.claimed)
            .ok_or(VaultError::MathOverflow)?;
        epoch.closed = true;

        let epoch_key = epoch.key();
        let epoch_index = epoch.index;

        let vault = &mut ctx.accounts.vault;
        vault.reserved = vault
            .reserved
            .checked_sub(unclaimed)
            .ok_or(VaultError::MathOverflow)?;

        emit!(EpochClosed {
            vault: vault.key(),
            epoch: epoch_key,
            index: epoch_index,
            unclaimed,
        });
        Ok(())
    }

    /// Hand publishing rights to another key. This is the only authority the vault has, and it is
    /// the right to publish, never the right to spend.
    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        require!(
            new_authority != Pubkey::default(),
            VaultError::EmptyAuthority
        );

        let vault = &mut ctx.accounts.vault;
        let previous = vault.authority;
        vault.authority = new_authority;

        emit!(AuthorityChanged {
            vault: vault.key(),
            previous,
            current: new_authority,
        });
        Ok(())
    }
}

// --- merkle ------------------------------------------------------------------------------------

/// One claimant's entitlement, committed as `sha256(0x00 || epoch_le || claimant || amount_le)`.
///
/// The epoch index is in the leaf so a proof belongs to one epoch and no other. Two epochs that
/// happened to name the same wallets for the same amounts would otherwise share a root, and a
/// proof issued for the first would open the second as well. Nothing would be paid out beyond what
/// was funded, since each epoch reserves its own total, but the same balance would be handed out
/// twice, and the cheapest place to rule that out is here.
pub fn leaf_hash(epoch_index: u64, claimant: &Pubkey, amount: u64) -> [u8; 32] {
    hashv(&[
        &[LEAF_PREFIX],
        &epoch_index.to_le_bytes(),
        claimant.as_ref(),
        &amount.to_le_bytes(),
    ])
    .to_bytes()
}

/// Walk a proof back to a root, pairing each step in sorted order.
pub fn root_from_proof(leaf: [u8; 32], proof: &[[u8; 32]]) -> [u8; 32] {
    let mut node = leaf;
    for sibling in proof {
        node = if node <= *sibling {
            hashv(&[&[NODE_PREFIX], &node, sibling]).to_bytes()
        } else {
            hashv(&[&[NODE_PREFIX], sibling, &node]).to_bytes()
        };
    }
    node
}

// --- state -------------------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// May publish epochs. May not spend.
    pub authority: Pubkey,
    pub mint: Pubkey,
    /// The token account holding every funded token. Owned by this PDA.
    pub token_account: Pubkey,
    /// Index the next epoch will take.
    pub epoch_count: u64,
    pub total_funded: u64,
    pub total_claimed: u64,
    /// Committed to open epochs and therefore unavailable to new ones. The vault's balance is
    /// always at least this, which is what makes a published epoch trustworthy.
    pub reserved: u64,
    pub bump: u8,
    pub funds_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub vault: Pubkey,
    pub index: u64,
    pub root: [u8; 32],
    pub total: u64,
    pub claimed: u64,
    /// How many leaves the root covers. Reported so the share claimed so far is legible on chain.
    pub claimants: u32,
    pub claimed_count: u32,
    pub published_at: i64,
    /// Last second a claim is accepted.
    pub deadline: i64,
    pub closed: bool,
    pub bump: u8,
}

/// Written once per claimant per epoch. Its existence is the double-claim guard.
#[account]
#[derive(InitSpace)]
pub struct ClaimStatus {
    pub epoch: Pubkey,
    pub claimant: Pubkey,
    pub amount: u64,
    pub claimed_at: i64,
    pub bump: u8,
}

// --- accounts ----------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = vault,
        seeds = [FUNDS_SEED, vault.key().as_ref()],
        bump,
    )]
    pub funds: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, Vault>,

    #[account(address = vault.mint @ VaultError::WrongMint)]
    pub mint: Account<'info, Mint>,

    #[account(mut, address = vault.token_account @ VaultError::WrongFundsAccount)]
    pub funds: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = funder_token.mint == vault.mint @ VaultError::WrongMint,
        constraint = funder_token.owner == funder.key() @ VaultError::WrongOwner,
    )]
    pub funder_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(index: u64)]
pub struct PublishEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,

    #[account(address = vault.token_account @ VaultError::WrongFundsAccount)]
    pub funds: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        space = 8 + Epoch::INIT_SPACE,
        seeds = [EPOCH_SEED, vault.key().as_ref(), &index.to_le_bytes()],
        bump,
    )]
    pub epoch: Account<'info, Epoch>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, Vault>,

    #[account(mut, has_one = vault @ VaultError::WrongVault)]
    pub epoch: Account<'info, Epoch>,

    #[account(
        init,
        payer = claimant,
        space = 8 + ClaimStatus::INIT_SPACE,
        seeds = [CLAIM_SEED, epoch.key().as_ref(), claimant.key().as_ref()],
        bump,
    )]
    pub claim_status: Account<'info, ClaimStatus>,

    #[account(address = vault.mint @ VaultError::WrongMint)]
    pub mint: Account<'info, Mint>,

    #[account(mut, address = vault.token_account @ VaultError::WrongFundsAccount)]
    pub funds: Account<'info, TokenAccount>,

    /// Where the claim lands. Any token account of theirs for this mint will do, and the client
    /// creates the associated one in the same transaction when they have none, which keeps the
    /// rent on the claimant and keeps `init_if_needed` out of a program that moves money.
    #[account(
        mut,
        constraint = claimant_token.mint == vault.mint @ VaultError::WrongMint,
        constraint = claimant_token.owner == claimant.key() @ VaultError::WrongOwner,
    )]
    pub claimant_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseEpoch<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,

    #[account(mut, has_one = vault @ VaultError::WrongVault)]
    pub epoch: Account<'info, Epoch>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority @ VaultError::Unauthorized)]
    pub vault: Account<'info, Vault>,
}

// --- events ------------------------------------------------------------------------------------

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct Funded {
    pub vault: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EpochPublished {
    pub vault: Pubkey,
    pub epoch: Pubkey,
    pub index: u64,
    pub root: [u8; 32],
    pub total: u64,
    pub claimants: u32,
    pub deadline: i64,
}

#[event]
pub struct Claimed {
    pub vault: Pubkey,
    pub epoch: Pubkey,
    pub index: u64,
    pub claimant: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EpochClosed {
    pub vault: Pubkey,
    pub epoch: Pubkey,
    pub index: u64,
    pub unclaimed: u64,
}

#[event]
pub struct AuthorityChanged {
    pub vault: Pubkey,
    pub previous: Pubkey,
    pub current: Pubkey,
}

// --- errors ------------------------------------------------------------------------------------

#[error_code]
pub enum VaultError {
    #[msg("Only the vault authority may do that")]
    Unauthorized,
    #[msg("Amount must be greater than zero")]
    AmountZero,
    #[msg("A merkle root of all zeroes is not a tree")]
    EmptyRoot,
    #[msg("Authority cannot be the default pubkey")]
    EmptyAuthority,
    #[msg("Epochs must be published in order")]
    WrongEpochIndex,
    #[msg("The claim window must be at least a day long")]
    ClaimWindowTooShort,
    #[msg("The vault does not hold enough unreserved balance to back this epoch")]
    InsufficientReserve,
    #[msg("That proof does not lead to this epoch's root")]
    InvalidProof,
    #[msg("That proof is longer than this program will walk")]
    ProofTooLong,
    #[msg("This epoch is closed")]
    EpochClosed,
    #[msg("This epoch's claim window has passed")]
    ClaimWindowClosed,
    #[msg("This epoch's claim window is still open")]
    ClaimWindowOpen,
    #[msg("Claims would exceed the total this epoch published")]
    ExceedsEpochTotal,
    #[msg("That epoch belongs to a different vault")]
    WrongVault,
    #[msg("That account is for a different mint")]
    WrongMint,
    #[msg("That is not this vault's funds account")]
    WrongFundsAccount,
    #[msg("That token account is not owned by the signer")]
    WrongOwner,
    #[msg("Arithmetic overflowed")]
    MathOverflow,
}
