const clampScore = (value) => Math.max(0, Math.min(100, Math.round(value)));

const severityBands = [
    { min: 85, label: 'Critical' },
    { min: 60, label: 'Risky' },
    { min: 35, label: 'Watch' },
    { min: 0, label: 'Clean' }
];

const addReason = (reasons, label, condition) => {
    if (condition) {
        reasons.push(label);
    }
};

const scoreRgbSignal = (bans = {}) => {
    if (!bans.rgb || bans.rgb <= 0) return 0;
    const base = Math.min(36, bans.rgb * 12);
    if (typeof bans.rgbDaysAgo === 'number' && bans.rgbDaysAgo <= 180) {
        return Math.min(48, base + 12);
    }
    return base;
};

const scoreServerBanSignal = (bans = {}) => {
    if (!bans.sb || bans.sb <= 0) return 0;
    let value = Math.min(45, bans.sb * 15);
    if (typeof bans.sbDaysAgo === 'number') {
        if (bans.sbDaysAgo <= 30) value += 10;
        else if (bans.sbDaysAgo <= 90) value += 6;
        else if (bans.sbDaysAgo <= 180) value += 3;
    }
    return Math.min(60, value);
};

const scoreNameAssociation = (match = 0) => {
    if (match >= 90) return 12;
    if (match >= 70) return 8;
    if (match >= 40) return 5;
    if (match <= 20) return -5;
    return 0;
};

export function scorePlayer(player) {
    if (!player) {
        return { score: 0, severity: 'Clean', reasons: ['No data available'] };
    }

    const reasons = [];
    let score = 0;
    const bans = player.banStatus || {};
    const assoc = Number(player.associates) || 0;
    const nameMatch = Number(player.nameMatch) || 0;
    const lastSeenDays = typeof player.lastSeenDaysAgo === 'number' ? player.lastSeenDaysAgo : null;

    const sbScore = scoreServerBanSignal(bans);
    if (sbScore > 0) {
        score += sbScore;
        addReason(reasons, `BattleMetrics bans x${bans.sb}`, true);
    }

    const rgbScore = scoreRgbSignal(bans);
    if (rgbScore > 0) {
        score += rgbScore;
        const recent = typeof bans.rgbDaysAgo === 'number' && bans.rgbDaysAgo <= 180;
        addReason(reasons, recent ? `Recent RGB x${bans.rgb}` : `Steam rust bans x${bans.rgb}`, true);
    }

    if (bans.vac) {
        score += 12;
        addReason(reasons, 'VAC banned', true);
    }

    if (assoc > 0) {
        score += Math.min(assoc * 5, 40);
        addReason(reasons, `Shared identifiers ${assoc}`, true);
    }

    if (player.profilePicMatch) {
        score += 20;
        addReason(reasons, 'Matching profile image', true);
    }

    const nameScore = scoreNameAssociation(nameMatch);
    if (nameScore !== 0) {
        score += nameScore;
        addReason(reasons, nameScore > 0 ? `Name similarity ${nameMatch}%` : 'Low name similarity', true);
    }

    if (lastSeenDays !== null) {
        if (lastSeenDays <= 3) {
            score += 5;
            addReason(reasons, 'Active within 72h', true);
        } else if (lastSeenDays <= 14) {
            score += 3;
            addReason(reasons, 'Active within 2 weeks', true);
        } else if (lastSeenDays > 180) {
            score -= 6;
            addReason(reasons, 'Inactive for 6+ months', true);
        }
    }

    score = clampScore(score);
    const severity = severityBands.find(band => score >= band.min)?.label || 'Clean';

    if (reasons.length === 0) {
        reasons.push('No elevated signals');
    }

    return { score, severity, reasons };
}
